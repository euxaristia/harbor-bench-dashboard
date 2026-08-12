package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	staleAfter    = 2 * time.Minute
	toolCallGrace = 15 * time.Minute
	cacheLifetime = 500 * time.Millisecond
)

//go:embed index.html dashboard.js
var assets embed.FS

type object map[string]any

type verifierFailure struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

type verifierSummary struct {
	Passed   any               `json:"passed"`
	Total    any               `json:"total"`
	Failures []verifierFailure `json:"failures"`
}

type trialSummary struct {
	Name            string           `json:"name"`
	Status          string           `json:"status"`
	Verifier        *verifierSummary `json:"verifier"`
	AgentName       any              `json:"agent_name"`
	AgentFile       any              `json:"agent_file"`
	AgentBytes      int64            `json:"agent_bytes"`
	Reward          *float64         `json:"reward"`
	Exception       any              `json:"exception"`
	StartedAt       *float64         `json:"started_at"`
	LastActivityAt  *float64         `json:"last_activity_at"`
	Result          any              `json:"result,omitempty"`
	VerifierDetails any              `json:"verifier_summary,omitempty"`
}

type jobSummary struct {
	Name       string         `json:"name"`
	Date       string         `json:"date"`
	Status     string         `json:"status"`
	AgentName  any            `json:"agent_name"`
	ModelName  any            `json:"model_name"`
	TaskNames  []string       `json:"task_names"`
	StartedAt  any            `json:"started_at"`
	FinishedAt any            `json:"finished_at"`
	Completed  int            `json:"n_completed"`
	Errored    int            `json:"n_errored"`
	Total      int            `json:"n_total"`
	Trials     []trialSummary `json:"trials"`
	started    float64
}

type buildSummary struct {
	Name          string   `json:"name"`
	Target        string   `json:"target"`
	Status        string   `json:"status"`
	Phase         string   `json:"phase"`
	StartedAt     *float64 `json:"started_at"`
	FinishedAt    *float64 `json:"finished_at"`
	ExitCode      any      `json:"exit_code"`
	LogBytes      int64    `json:"log_bytes"`
	CompiledUnits int      `json:"compiled_units"`
	CurrentUnit   any      `json:"current_unit"`
}

type responseCache struct {
	mu       sync.Mutex
	at       time.Time
	withJunk bool
	jobs     []jobSummary
}

type server struct {
	jobsDir   string
	buildsDir string
	cache     responseCache
}

var (
	toolUsePattern    = regexp.MustCompile(`"type"\s*:\s*"tool_use"`)
	toolResultPattern = regexp.MustCompile(`"type"\s*:\s*"tool_result"`)
	buildPhasePattern = regexp.MustCompile(`(?m)^::phase::(.+)$`)
	cargoUnitPattern  = regexp.MustCompile(`(?m)^\s*(?:Compiling|Checking)\s+([^\s]+)`)
	authMarkers       = [][]byte{[]byte("HTTP 403"), []byte("OAuth2 access token could not be validated"), []byte("invalid_grant"), []byte("The access token expired")}
)

func readObject(path string) object {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var value object
	if json.Unmarshal(data, &value) != nil {
		return nil
	}
	return value
}

func readText(path string) *string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	value := strings.TrimSpace(strings.ToValidUTF8(string(data), "�"))
	return &value
}

func nested(value any, keys ...string) any {
	current := value
	for _, key := range keys {
		item, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = item[key]
	}
	return current
}

func stringValue(value any, fallback string) string {
	if text, ok := value.(string); ok && text != "" {
		return text
	}
	return fallback
}

func intValue(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	default:
		return 0
	}
}

func modTime(path string) *float64 {
	info, err := os.Stat(path)
	if err != nil {
		return nil
	}
	value := float64(info.ModTime().UnixNano()) / 1e9
	return &value
}

func lastActivity(dir string) *float64 {
	var newest *float64
	_ = filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		value := float64(info.ModTime().UnixNano()) / 1e9
		if newest == nil || value > *newest {
			newest = &value
		}
		return nil
	})
	return newest
}

func agentFiles(trialDir string) []string {
	files, _ := filepath.Glob(filepath.Join(trialDir, "agent", "*.txt"))
	sort.Strings(files)
	return files
}

func awaitingToolResult(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return false
	}
	const tailBytes = int64(256 * 1024)
	if info.Size() > tailBytes {
		_, _ = file.Seek(info.Size()-tailBytes, io.SeekStart)
	}
	data, _ := io.ReadAll(file)
	lastUse := bytes.LastIndex(data, []byte(`"type":"tool_use"`))
	lastResult := bytes.LastIndex(data, []byte(`"type":"tool_result"`))
	if lastUse < 0 {
		uses := toolUsePattern.FindAllIndex(data, -1)
		results := toolResultPattern.FindAllIndex(data, -1)
		if len(uses) > 0 {
			lastUse = uses[len(uses)-1][0]
		}
		if len(results) > 0 {
			lastResult = results[len(results)-1][0]
		}
	}
	return lastUse > lastResult
}

func inFlightToolCall(files []string, activity *float64) bool {
	if len(files) == 0 || activity == nil || time.Since(time.Unix(0, int64(*activity*1e9))) > toolCallGrace {
		return false
	}
	return awaitingToolResult(files[0])
}

func failureDetail(trace string) string {
	var lines []string
	for _, line := range strings.Split(trace, "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, strings.TrimRight(line, "\r\t "))
		}
	}
	if len(lines) == 0 {
		return ""
	}
	for i := len(lines) - 1; i >= 0; i-- {
		trimmed := strings.TrimLeft(lines[i], " \t")
		if strings.HasPrefix(trimmed, "E ") {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, "E "))
		}
	}
	return strings.TrimSpace(lines[len(lines)-1])
}

func verifierFor(trialDir string) *verifierSummary {
	ctrf := readObject(filepath.Join(trialDir, "verifier", "ctrf.json"))
	results, ok := nested(ctrf, "results").(map[string]any)
	if !ok {
		return nil
	}
	summary, _ := results["summary"].(map[string]any)
	value := &verifierSummary{Failures: []verifierFailure{}}
	value.Passed = summary["passed"]
	value.Total = summary["tests"]
	for _, raw := range asSlice(results["tests"]) {
		test, ok := raw.(map[string]any)
		if !ok || test["status"] == "passed" {
			continue
		}
		detail := strings.TrimSpace(stringValue(test["trace"], stringValue(test["message"], "")))
		value.Failures = append(value.Failures, verifierFailure{
			Name: stringValue(test["name"], "?"), Status: stringValue(test["status"], "failed"), Detail: failureDetail(detail),
		})
	}
	return value
}

func asSlice(value any) []any {
	items, _ := value.([]any)
	return items
}

func summarizeTrial(trialDir string) trialSummary {
	result := readObject(filepath.Join(trialDir, "result.json"))
	exceptionPath := filepath.Join(trialDir, "exception.txt")
	files := agentFiles(trialDir)
	var size int64
	if len(files) > 0 {
		if info, err := os.Stat(files[0]); err == nil {
			size = info.Size()
		}
	}
	var reward *float64
	if text := readText(filepath.Join(trialDir, "verifier", "reward.txt")); text != nil {
		if value, err := strconv.ParseFloat(*text, 64); err == nil {
			reward = &value
		}
	}
	started := modTime(filepath.Join(trialDir, "lock.json"))
	activity := lastActivity(trialDir)
	stale := activity != nil && time.Since(time.Unix(0, int64(*activity*1e9))) > staleAfter
	status := "running"
	if result != nil || reward != nil {
		status = "done"
	} else if _, err := os.Stat(exceptionPath); err == nil {
		status = "errored"
	} else if stale && !inFlightToolCall(files, activity) {
		status = "stalled"
	}
	agentName := nested(result, "config", "agent", "name")
	if stringValue(agentName, "") == "" {
		agentName = nested(readObject(filepath.Join(trialDir, "lock.json")), "agent", "name")
	}
	if name, ok := agentName.(string); ok {
		if at := strings.LastIndex(name, ":"); at >= 0 {
			agentName = name[at+1:]
		}
	}
	var agentFile any
	if len(files) > 0 {
		agentFile = filepath.Base(files[0])
	}
	var exception any
	if status == "errored" {
		if text := readText(exceptionPath); text != nil {
			exception = *text
		}
	}
	return trialSummary{
		Name: filepath.Base(trialDir), Status: status, Verifier: verifierFor(trialDir), AgentName: agentName,
		AgentFile: agentFile, AgentBytes: size, Reward: reward, Exception: exception,
		StartedAt: started, LastActivityAt: activity,
	}
}

func firstAgentLog(trialDir string, limit int64) []byte {
	files := agentFiles(trialDir)
	if len(files) == 0 {
		return nil
	}
	file, err := os.Open(files[0])
	if err != nil {
		return nil
	}
	defer file.Close()
	data, _ := io.ReadAll(io.LimitReader(file, limit))
	return data
}

func junkJob(jobDir string) bool {
	entries, err := os.ReadDir(jobDir)
	if err != nil {
		return false
	}
	sawLog, sawAuth := false, false
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		data := firstAgentLog(filepath.Join(jobDir, entry.Name()), 512*1024)
		if data == nil {
			continue
		}
		sawLog = true
		if toolUsePattern.Match(data) {
			return false
		}
		for _, marker := range authMarkers {
			if bytes.Contains(data, marker) {
				sawAuth = true
			}
		}
	}
	return sawLog && sawAuth
}

func jobStarted(jobDir string) float64 {
	name := filepath.Base(jobDir)
	if len(name) >= 20 {
		if value, err := time.ParseInLocation("2006-01-02__15-04-05", name[:20], time.Local); err == nil {
			return float64(value.UnixNano()) / 1e9
		}
	}
	if info, err := os.Stat(jobDir); err == nil {
		return float64(info.ModTime().UnixNano()) / 1e9
	}
	return 0
}

func summarizeJob(jobDir string) jobSummary {
	config := readObject(filepath.Join(jobDir, "config.json"))
	result := readObject(filepath.Join(jobDir, "result.json"))
	entries, _ := os.ReadDir(jobDir)
	trials := make([]trialSummary, 0)
	for _, entry := range entries {
		if entry.IsDir() {
			trials = append(trials, summarizeTrial(filepath.Join(jobDir, entry.Name())))
		}
	}
	sort.Slice(trials, func(i, j int) bool {
		left, right := trials[i], trials[j]
		leftPass := left.Reward != nil && *left.Reward > 0
		rightPass := right.Reward != nil && *right.Reward > 0
		if leftPass != rightPass {
			return leftPass
		}
		leftReward, rightReward := 0.0, 0.0
		if left.Reward != nil {
			leftReward = *left.Reward
		}
		if right.Reward != nil {
			rightReward = *right.Reward
		}
		if leftReward != rightReward {
			return leftReward > rightReward
		}
		return left.Name < right.Name
	})
	agents := asSlice(config["agents"])
	var agentName, modelName any
	if len(agents) > 0 {
		if agent, ok := agents[0].(map[string]any); ok {
			agentName, modelName = agent["name"], agent["model_name"]
		}
	}
	var taskNames []string
	for _, rawDataset := range asSlice(config["datasets"]) {
		if dataset, ok := rawDataset.(map[string]any); ok {
			for _, rawName := range asSlice(dataset["task_names"]) {
				if name, ok := rawName.(string); ok {
					taskNames = append(taskNames, name)
				}
			}
		}
	}
	status := "stalled"
	if result != nil && result["finished_at"] != nil {
		status = "done"
	} else {
		for _, trial := range trials {
			if trial.Status == "running" {
				status = "running"
				break
			}
		}
	}
	completed, errored := 0, 0
	for _, trial := range trials {
		if trial.Status == "done" {
			completed++
		}
		if trial.Status == "errored" {
			errored++
		}
	}
	total := intValue(result["n_total_trials"])
	if total == 0 {
		total = len(trials)
	}
	started := jobStarted(jobDir)
	date := "unknown"
	if started > 0 {
		date = time.Unix(0, int64(started*1e9)).Format("2006-01-02")
	}
	return jobSummary{
		Name: filepath.Base(jobDir), Date: date, Status: status, AgentName: agentName, ModelName: modelName,
		TaskNames: taskNames, StartedAt: result["started_at"], FinishedAt: result["finished_at"],
		Completed: completed, Errored: errored, Total: total, Trials: trials, started: started,
	}
}

func listJobs(jobsDir string, includeJunk bool) []jobSummary {
	entries, err := os.ReadDir(jobsDir)
	if err != nil {
		return []jobSummary{}
	}
	jobs := make([]jobSummary, 0)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(jobsDir, entry.Name())
		if !includeJunk && junkJob(path) {
			continue
		}
		jobs = append(jobs, summarizeJob(path))
	}
	sort.Slice(jobs, func(i, j int) bool {
		if jobs[i].started == jobs[j].started {
			return jobs[i].Name > jobs[j].Name
		}
		return jobs[i].started > jobs[j].started
	})
	return jobs
}

func isoEpoch(value any) *float64 {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339, text)
	if err != nil {
		return nil
	}
	result := float64(parsed.UnixNano()) / 1e9
	return &result
}

func summarizeBuild(buildDir string) buildSummary {
	meta := readObject(filepath.Join(buildDir, "meta.json"))
	logPath := filepath.Join(buildDir, "build.log")
	data, _ := os.ReadFile(logPath)
	phases := buildPhasePattern.FindAllSubmatch(data, -1)
	units := cargoUnitPattern.FindAllSubmatch(data, -1)
	phase := stringValue(meta["phase"], "starting")
	if len(phases) > 0 {
		phase = string(phases[len(phases)-1][1])
	}
	started := isoEpoch(meta["started_at"])
	if started == nil {
		started = modTime(logPath)
	}
	var current any
	if len(units) > 0 {
		current = string(units[len(units)-1][1])
	}
	var size int64
	if info, err := os.Stat(logPath); err == nil {
		size = info.Size()
	}
	return buildSummary{
		Name: filepath.Base(buildDir), Target: stringValue(meta["target"], "unknown"),
		Status: stringValue(meta["status"], "running"), Phase: phase, StartedAt: started,
		FinishedAt: isoEpoch(meta["finished_at"]), ExitCode: meta["exit_code"], LogBytes: size,
		CompiledUnits: len(units), CurrentUnit: current,
	}
}

func listBuilds(buildsDir string) []buildSummary {
	entries, err := os.ReadDir(buildsDir)
	if err != nil {
		return []buildSummary{}
	}
	builds := make([]buildSummary, 0)
	for _, entry := range entries {
		if entry.IsDir() {
			builds = append(builds, summarizeBuild(filepath.Join(buildsDir, entry.Name())))
		}
	}
	sort.Slice(builds, func(i, j int) bool {
		if builds[i].StartedAt == nil {
			return false
		}
		if builds[j].StartedAt == nil {
			return true
		}
		return *builds[i].StartedAt > *builds[j].StartedAt
	})
	return builds
}

func tailFile(path string, offset int64, completeLines bool) (string, int64) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", 0
	}
	if offset < 0 || offset > info.Size() {
		offset = 0
	}
	_, _ = file.Seek(offset, io.SeekStart)
	data, _ := io.ReadAll(file)
	if completeLines {
		last := bytes.LastIndexByte(data, '\n')
		if last < 0 {
			return "", offset
		}
		data = data[:last+1]
	}
	return strings.ToValidUTF8(string(data), "�"), offset + int64(len(data))
}

func tailEvents(trialDir string, offset int64) object {
	files := agentFiles(trialDir)
	if len(files) == 0 {
		return object{"events": []any{}, "offset": 0}
	}
	text, next := tailFile(files[0], offset, true)
	events := make([]any, 0)
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var event any
		if json.Unmarshal([]byte(line), &event) != nil {
			event = object{"type": "raw", "text": line}
		}
		events = append(events, event)
	}
	return object{"events": events, "offset": next}
}

func (s *server) cachedJobs(includeJunk bool) []jobSummary {
	s.cache.mu.Lock()
	defer s.cache.mu.Unlock()
	if s.cache.jobs != nil && s.cache.withJunk == includeJunk && time.Since(s.cache.at) < cacheLifetime {
		return s.cache.jobs
	}
	s.cache.jobs = listJobs(s.jobsDir, includeJunk)
	s.cache.withJunk = includeJunk
	s.cache.at = time.Now()
	return s.cache.jobs
}

func safeChild(root, name string) (string, bool) {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name || strings.ContainsAny(name, `/\\`) {
		return "", false
	}
	return filepath.Join(root, name), true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func renderIndex() []byte {
	html, _ := assets.ReadFile("index.html")
	js, err := os.ReadFile("dashboard.js")
	if err != nil {
		js, _ = assets.ReadFile("dashboard.js")
	}
	return bytes.Replace(html, []byte("__DASHBOARD_JS__"), js, 1)
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// SECURITY: Add standard security headers to prevent XSS and clickjacking
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")

	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	parts := strings.FieldsFunc(r.URL.Path, func(ch rune) bool { return ch == '/' })
	if len(parts) == 0 {
		body := renderIndex()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		_, _ = w.Write(body)
		return
	}
	if parts[0] != "api" {
		http.NotFound(w, r)
		return
	}
	if len(parts) == 2 && parts[1] == "jobs" {
		query := strings.ToLower(r.URL.Query().Get("include_junk"))
		writeJSON(w, 200, s.cachedJobs(query == "1" || query == "true" || query == "yes"))
		return
	}
	if len(parts) == 2 && parts[1] == "builds" {
		writeJSON(w, 200, listBuilds(s.buildsDir))
		return
	}
	if len(parts) == 4 && parts[1] == "builds" && parts[3] == "log" {
		buildDir, ok := safeChild(s.buildsDir, parts[2])
		if !ok {
			http.NotFound(w, r)
			return
		}
		offset, _ := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
		text, next := tailFile(filepath.Join(buildDir, "build.log"), offset, false)
		writeJSON(w, 200, object{"text": text, "offset": next})
		return
	}
	if len(parts) == 6 && parts[1] == "jobs" && parts[3] == "trials" {
		jobDir, okJob := safeChild(s.jobsDir, parts[2])
		trialDir, okTrial := safeChild(jobDir, parts[4])
		if !okJob || !okTrial {
			http.NotFound(w, r)
			return
		}
		if info, err := os.Stat(trialDir); err != nil || !info.IsDir() {
			http.NotFound(w, r)
			return
		}
		if parts[5] == "events" {
			offset, _ := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
			writeJSON(w, 200, tailEvents(trialDir, offset))
			return
		}
		if parts[5] == "result" {
			summary := summarizeTrial(trialDir)
			summary.Result = readObject(filepath.Join(trialDir, "result.json"))
			summary.VerifierDetails = nested(readObject(filepath.Join(trialDir, "verifier", "ctrf.json")), "results", "summary")
			writeJSON(w, 200, summary)
			return
		}
	}
	http.NotFound(w, r)
}

func main() {
	jobsDir := flag.String("jobs-dir", "jobs", "directory containing Harbor jobs")
	buildsDir := flag.String("builds-dir", "", "directory containing build logs")
	port := flag.Int("port", 8787, "loopback port")
	flag.Parse()
	jobs, err := filepath.Abs(*jobsDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	builds := *buildsDir
	if builds == "" {
		builds = filepath.Join(filepath.Dir(jobs), "builds")
	}
	builds, err = filepath.Abs(builds)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	handler := &server{jobsDir: jobs, buildsDir: builds}
	address := fmt.Sprintf("127.0.0.1:%d", *port)
	fmt.Printf("watching %s\nwatching builds in %s\ndashboard: http://%s/\n", jobs, builds, address)

	// SECURITY: Use explicit server with timeouts to prevent resource exhaustion/Slowloris
	srv := &http.Server{
		Addr:              address,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
