package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTailEventsOnlyAdvancesPastCompleteLines(t *testing.T) {
	trial := t.TempDir()
	agent := filepath.Join(trial, "agent")
	if err := os.Mkdir(agent, 0o755); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(agent, "events.txt")
	if err := os.WriteFile(logPath, []byte("{\"type\":\"text\",\"text\":\"one\"}\n{\"type\":"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := tailEvents(trial, 0)
	if got := len(result["events"].([]any)); got != 1 {
		t.Fatalf("events = %d, want 1", got)
	}
	offset := result["offset"].(int64)
	if err := os.WriteFile(logPath, []byte("{\"type\":\"text\",\"text\":\"one\"}\n{\"type\":\"text\",\"text\":\"two\"}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result = tailEvents(trial, offset)
	if got := len(result["events"].([]any)); got != 1 {
		t.Fatalf("events after append = %d, want 1", got)
	}
}

func TestTailEventsBoundsInitialTranscript(t *testing.T) {
	trial := t.TempDir()
	agent := filepath.Join(trial, "agent")
	if err := os.Mkdir(agent, 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"text","text":"` + strings.Repeat("x", 1000) + `"}` + "\n"
	content := strings.Repeat(line, 600) + `{"type":"text","text":"latest"}` + "\n"
	if err := os.WriteFile(filepath.Join(agent, "events.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	result := tailEvents(trial, 0)
	if result["truncated"] != true {
		t.Fatal("initial transcript was not truncated")
	}
	events := result["events"].([]any)
	if len(events) >= 601 {
		t.Fatalf("events = %d, want a bounded tail", len(events))
	}
	last := events[len(events)-1].(map[string]any)
	if last["text"] != "latest" {
		t.Fatalf("last event = %#v, want latest", last)
	}
}

func TestSummarizeBuild(t *testing.T) {
	dir := t.TempDir()
	meta := object{"target": "linux-x86_64", "status": "running", "started_at": "2026-08-08T12:00:00Z"}
	data, _ := json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	log := "::phase::compiling release binary\n   Compiling serde v1\n   Checking cairn-code v1\n"
	if err := os.WriteFile(filepath.Join(dir, "build.log"), []byte(log), 0o644); err != nil {
		t.Fatal(err)
	}
	build := summarizeBuild(dir)
	if build.Phase != "compiling release binary" || build.CompiledUnits != 2 || build.CurrentUnit != "cairn-code" {
		t.Fatalf("unexpected build summary: %+v", build)
	}
}

func TestSummarizeTrialMarksPreAgentFailureStalled(t *testing.T) {
	trial := t.TempDir()
	result := object{
		"agent_result":    nil,
		"verifier_result": nil,
		"exception_info":  object{"exception_type": "RuntimeError"},
	}
	data, _ := json.Marshal(result)
	if err := os.WriteFile(filepath.Join(trial, "result.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(trial, "exception.txt"), []byte("environment setup failed"), 0o644); err != nil {
		t.Fatal(err)
	}

	summary := summarizeTrial(trial)
	if summary.Status != "stalled" || summary.AgentBytes != 0 {
		t.Fatalf("unexpected trial summary: %+v", summary)
	}
	if summary.Exception != "environment setup failed" {
		t.Fatalf("exception = %#v", summary.Exception)
	}
}

func TestSummarizeTrialWaitsTenMinutesBeforeMarkingQuietRunStalled(t *testing.T) {
	trial := t.TempDir()
	agent := filepath.Join(trial, "agent")
	if err := os.Mkdir(agent, 0o755); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(trial, "lock.json")
	log := filepath.Join(agent, "events.txt")
	if err := os.WriteFile(lock, []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(log, []byte("quiet provider request\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	threeMinutesAgo := time.Now().Add(-3 * time.Minute)
	if err := os.Chtimes(lock, threeMinutesAgo, threeMinutesAgo); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(log, threeMinutesAgo, threeMinutesAgo); err != nil {
		t.Fatal(err)
	}
	if summary := summarizeTrial(trial); summary.Status != "running" {
		t.Fatalf("three-minute quiet trial status = %q, want running", summary.Status)
	}

	elevenMinutesAgo := time.Now().Add(-11 * time.Minute)
	if err := filepath.WalkDir(trial, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Chtimes(path, elevenMinutesAgo, elevenMinutesAgo)
	}); err != nil {
		t.Fatal(err)
	}
	if summary := summarizeTrial(trial); summary.Status != "stalled" {
		t.Fatalf("eleven-minute quiet trial status = %q, want stalled", summary.Status)
	}
}
func TestSafeChildRejectsTraversal(t *testing.T) {
	if _, ok := safeChild(t.TempDir(), ".."); ok {
		t.Fatal("accepted parent traversal")
	}
	if _, ok := safeChild(t.TempDir(), `a\\b`); ok {
		t.Fatal("accepted nested path")
	}
}
