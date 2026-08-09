// Client for the Harbor bench dashboard. Compiled to dashboard.js with bun
// (`bun build dashboard.ts --target=browser --format=iife --outfile=dashboard.js`)
// and served inline by dashboard.py, which reads the compiled output from
// disk rather than embedding hand-written JS in a Python string. Only
// editing this file requires bun; running the server does not.

interface VerifierFailure {
  name: string;
  status: string;
  detail: string;
}

interface VerifierSummary {
  passed: number | null;
  total: number | null;
  failures: VerifierFailure[];
}

interface TrialSummary {
  name: string;
  verifier: VerifierSummary | null;
  status: "running" | "done" | "errored" | "stalled";
  agent_name: string | null;
  agent_file: string | null;
  agent_bytes: number;
  reward: number | null;
  exception: string | null;
  started_at: number | null;
  last_activity_at: number | null;
}

interface JobSummary {
  name: string;
  date: string;
  status: "running" | "done" | "stalled";
  agent_name: string | null;
  model_name: string | null;
  task_names: string[];
  started_at: string | null;
  finished_at: string | null;
  n_completed: number | null;
  n_errored: number | null;
  n_total: number | null;
  trials: TrialSummary[];
}

interface BuildSummary {
  name: string;
  target: string;
  status: "running" | "succeeded" | "failed";
  phase: string;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  log_bytes: number;
  compiled_units: number;
  current_unit: string | null;
}

interface BenchTextEvent { type: "text"; text: string; }
interface BenchToolUseEvent { type: "tool_use"; name: string; text: string; }
interface BenchToolResultEvent { type: "tool_result"; name: string; text: string; }
interface BenchErrorEvent { type: "error"; message: string; }
interface BenchRunEndEvent { type: "run_end"; status: string; exitCode: number; }
interface BenchRawEvent { type: "raw"; text: string; }
interface BenchOtherEvent { type: string; [key: string]: unknown; }

type BenchEvent =
  | BenchTextEvent
  | BenchToolUseEvent
  | BenchToolResultEvent
  | BenchErrorEvent
  | BenchRunEndEvent
  | BenchRawEvent
  | BenchOtherEvent;

interface EventsResponse {
  events: BenchEvent[];
  offset: number;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function localDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const todayKey = localDateKey(new Date());

let jobsCache: JobSummary[] = [];
let buildsCache: BuildSummary[] = [];
// trial === null means the job overview is selected, not a single transcript.
let selected: { job: string; trial: string | null } | null = null;
let selectedBuild: string | null = null;
let eventsOffset = 0;
let buildLogOffset = 0;
// tool name -> queue of open <details> elements awaiting their result, FIFO.
let toolQueues: Record<string, HTMLDetailsElement[]> = {};
let eventsTimer: ReturnType<typeof setInterval> | null = null;
let toolCount = 0;
// Which date groups are expanded in the sidebar. Seeded once here, at
// script load, rather than recomputed inside renderSidebar(): that function
// reruns every 4s as jobs are polled, and re-deciding "today should be open"
// on every call would silently re-expand a group the user had just clicked
// closed.
const expandedDates = new Set<string>([todayKey]);

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

let hideJunkRuns = true;

function isJunkJob(job: JobSummary): boolean {
  if (job.status === "running") return false;
  if (job.trials.some((t) => t.status === "running")) return false;
  const completed = job.n_completed ?? 0;
  if (completed > 0) return false;
  const hasPass = job.trials.some((t) => t.reward != null && t.reward > 0);
  if (hasPass) return false;
  return true;
}

// Anchored to real file timestamps from the server, not to whenever the
// page happened to load: a trial that stopped producing output hours ago
// must show a duration that stops too, not one that keeps climbing forever
// just because the dashboard tab is still open.
function trialDotClass(trial: TrialSummary): string {
  if (trial.status === "errored") return "errored";
  if (trial.reward != null && trial.reward <= 0) return "errored";
  if (trial.exception) return "errored";
  return trial.status;
}

function trialSortPriority(trial: TrialSummary): number {
  if (trial.status === "running") return 0;
  if (trial.reward != null && trial.reward > 0) return 1;
  if (trial.status === "stalled") return 3;
  return 2;
}

function trialElapsed(trial: TrialSummary): string {
  if (trial.started_at == null) return "";
  const endpoint =
    trial.status === "running" ? Date.now() / 1000 : trial.last_activity_at ?? trial.started_at;
  return fmtDuration(endpoint - trial.started_at);
}

function currentElapsed(): string {
  if (!selected || !selected.trial) return "";
  const job = jobsCache.find((j) => j.name === selected!.job);
  const trial = job && job.trials.find((t) => t.name === selected!.trial);
  if (!trial) return "";
  return trialElapsed(trial);
}

async function pollJobs(): Promise<void> {
  try {
    const [jobsResponse, buildsResponse] = await Promise.all([
      fetch("/api/jobs"),
      fetch("/api/builds"),
    ]);
    jobsCache = await jobsResponse.json();
    buildsCache = await buildsResponse.json();
    renderSidebar();
    // The header's status label is set once by updateHeader() when a trial
    // is selected and otherwise never touched again, unlike elapsed time and
    // tool count, which pollEvents() refreshes every 1.2s. Without this it
    // can go on saying "running" for a trial the sidebar (rebuilt from the
    // same fetch, a few lines up) already correctly shows as stalled or done.
    if (selected) {
      if (selected.trial) {
        const job = jobsCache.find((j) => j.name === selected!.job);
        const trial = job && job.trials.find((t) => t.name === selected!.trial);
        const statusEl = document.getElementById("trial-status");
        if (statusEl && trial) statusEl.textContent = trial.status;
      } else {
        // Keep the overview live as trials finish without blowing away scroll.
        renderJobOverview(selected.job, { preserveScroll: true });
      }
    }
    if (selectedBuild) updateBuildHeader();
    if (!selected && !selectedBuild) {
      const runningBuild = buildsCache.find((build) => build.status === "running");
      if (runningBuild) {
        selectBuild(runningBuild.name);
        return;
      }
    }
    if (!selected && !selectedBuild && jobsCache.length) {
      // Open the newest job's overview, not a single trial: that is the
      // entry point for comparing arms before diving into a transcript.
      selectJob(jobsCache[0].name);
    }
  } catch {
    // server not up yet, or a job dir mid-write; retry next tick
  }
}

// A job that was killed mid-flight still writes a result.json, with the
// unfinished trials left in running/pending. Showing only "N/M done" made
// that look like an ordinary finished job that happened to have fewer
// trials, so the abandoned ones have to be named explicitly.
function jobProgress(job: JobSummary): string {
  if (job.n_completed == null || job.n_total == null) return "";
  let s = job.status === "running" ? ` &middot; ${job.n_completed}/${job.n_total} done` : "";
  // Over trials that have actually been scored, not over the whole job: while
  // a run is in progress, dividing by the total would start every job at 0%
  // and creep up as trials land, which reads as a falling score rather than
  // an incomplete one. Bare "100% pass" with rows still running is the other
  // trap: it looks like the whole job finished green. Show a fraction among
  // scored trials. The status immediately before this already says "done"
  // for a completed job, so repeating "1/1 done" adds no information.
  const scored = job.trials.filter((t) => t.reward != null);
  const unfinished = job.n_total - job.n_completed - (job.n_errored || 0);
  if (scored.length) {
    const passed = scored.filter((t) => (t.reward || 0) > 0).length;
    const cls = passed > 0 ? "verifier-ok" : "verifier-bad";
    s += ` &middot; <span class="${cls}">passed ${passed}/${scored.length}</span>`;
  }
  // Only worth flagging once the job has stopped: while it runs, "unfinished"
  // is just the trials that have not had their turn yet, which is normal and
  // not something to colour red.
  if (unfinished > 0 && job.status !== "running") {
    s += ` &middot; <span class="verifier-bad">${unfinished} unfinished</span>`;
  }
  if (job.n_errored) s += ` &middot; ${job.n_errored} errored`;
  return s;
}

function renderSidebar(): void {
  const el = byId<HTMLDivElement>("sidebar");
  el.innerHTML = "";

  const junkCount = jobsCache.filter(isJunkJob).length;
  const visibleJobs = jobsCache.filter((j) => !hideJunkRuns || !isJunkJob(j));

  const filterBar = document.createElement("div");
  filterBar.className = "sidebar-filter";
  filterBar.innerHTML = `<label><input type="checkbox" id="hide-junk-toggle" ${hideJunkRuns ? "checked" : ""} /> Hide empty runs</label>
    <span class="junk-count">${junkCount ? `(${junkCount} hidden)` : ""}</span>`;
  const toggleInput = filterBar.querySelector<HTMLInputElement>("#hide-junk-toggle");
  if (toggleInput) {
    toggleInput.onchange = () => {
      hideJunkRuns = toggleInput.checked;
      renderSidebar();
    };
  }
  el.appendChild(filterBar);

  if (buildsCache.length) {
    const buildsGroup = document.createElement("details");
    buildsGroup.className = "date-group";
    buildsGroup.open = true;
    const summary = document.createElement("summary");
    summary.className = "date-head";
    summary.textContent = `Builds — ${buildsCache.length}`;
    buildsGroup.appendChild(summary);
    for (const build of buildsCache) {
      const row = document.createElement("div");
      row.className = "trial" + (selectedBuild === build.name ? " selected" : "");
      const dotClass =
        build.status === "failed" ? "errored" : build.status === "succeeded" ? "done" : "running";
      const detail = build.status === "running" ? build.phase : build.status;
      row.innerHTML = `<span class="dot ${dotClass}"></span>
        <span class="tname" title="${escapeHtml(build.name)}">${escapeHtml(build.name)}</span>
        <span class="reward">${escapeHtml(detail)}</span>`;
      row.onclick = () => selectBuild(build.name);
      buildsGroup.appendChild(row);
    }
    el.appendChild(buildsGroup);
  }

  // Group by calendar date, preserving jobsCache's newest-first order both
  // across groups and within each one.
  const groups: { date: string; jobs: JobSummary[] }[] = [];
  const byDate = new Map<string, { date: string; jobs: JobSummary[] }>();
  for (const job of visibleJobs) {
    const key = job.date || "unknown";
    let group = byDate.get(key);
    if (!group) {
      group = { date: key, jobs: [] };
      byDate.set(key, group);
      groups.push(group);
    }
    group.jobs.push(job);
  }

  for (const group of groups) {
    const isToday = group.date === todayKey;
    const dateEl = document.createElement("details");
    dateEl.className = "date-group";
    dateEl.open = expandedDates.has(group.date);
    dateEl.ontoggle = () => {
      if (dateEl.open) expandedDates.add(group.date);
      else expandedDates.delete(group.date);
    };
    const dateSummary = document.createElement("summary");
    dateSummary.className = "date-head";
    const n = group.jobs.length;
    dateSummary.textContent = `${group.date}${isToday ? " (today)" : ""} — ${n} job${n === 1 ? "" : "s"}`;
    dateEl.appendChild(dateSummary);

    for (const job of group.jobs) {
      const jobEl = document.createElement("div");
      jobEl.className = "job";
      const head = document.createElement("div");
      const jobSelected = selected && selected.job === job.name && selected.trial == null;
      head.className = "job-head" + (jobSelected ? " selected" : "");
      head.innerHTML = `<div class="name">${escapeHtml(job.name)}</div>
        <div class="meta">${escapeHtml(job.model_name || "")} &middot; ${escapeHtml(job.status)}
        ${jobProgress(job)}</div>`;
      head.onclick = () => selectJob(job.name);
      jobEl.appendChild(head);
      if (job.trials.length === 0 && job.status === "running") {
        const t = document.createElement("div");
        t.className = "trial starting";
        t.innerHTML = `<span class="dot running"></span>
          <span class="tname" style="font-style: italic; color: var(--accent)">Starting trial...</span>`;
        jobEl.appendChild(t);
      } else {
        const sortedTrials = [...job.trials].sort((a, b) => trialSortPriority(a) - trialSortPriority(b));
        for (const trial of sortedTrials) {
          const t = document.createElement("div");
          t.className =
            "trial" + (selected && selected.job === job.name && selected.trial === trial.name ? " selected" : "");
          let rewardText = trial.reward != null ? `reward ${trial.reward}` : "";
          if (!rewardText && trial.status === "running") {
            rewardText = trial.agent_bytes > 0 ? "running..." : "starting...";
          }
          const dotClass = trialDotClass(trial);
          t.innerHTML = `<span class="dot ${dotClass}"></span>
            <span class="tname" title="${escapeHtml(trial.name)}">${escapeHtml(trial.name)}</span>
            <span class="reward">${rewardText}</span>`;
          t.onclick = () => selectTrial(job.name, trial.name);
          jobEl.appendChild(t);
        }
      }
      dateEl.appendChild(jobEl);
    }
    el.appendChild(dateEl);
  }
}

function selectJob(job: string): void {
  selectedBuild = null;
  selected = { job, trial: null };
  eventsOffset = 0;
  toolQueues = {};
  toolCount = 0;
  if (eventsTimer) {
    clearInterval(eventsTimer);
    eventsTimer = null;
  }
  renderSidebar();
  renderJobOverview(job);
}

function selectTrial(job: string, trial: string): void {
  selectedBuild = null;
  selected = { job, trial };
  eventsOffset = 0;
  toolQueues = {};
  toolCount = 0;
  const jobData = jobsCache.find((j) => j.name === job);
  const trialData = jobData && jobData.trials.find((t) => t.name === trial);
  const transcript = byId<HTMLDivElement>("transcript");
  // A stalled trial with real bytes on disk still has a transcript worth
  // showing (the first pollEvents() call below will fetch all of it from
  // offset 0); only the genuinely empty case needs an explanatory
  // placeholder instead of real content there will never be any of.
  if (trialData && trialData.status === "stalled" && !trialData.agent_bytes) {
    transcript.innerHTML = `<div class="empty">This trial never wrote any agent output and hasn't in over two minutes.
      It most likely crashed before the agent started (check trial.log / exception.txt in its job directory).</div>`;
  } else {
    transcript.innerHTML = `<div class="empty">Waiting for output…</div>`;
  }
  renderSidebar();
  updateHeader();
  renderVerifierBanner(transcript, trialData);
  if (eventsTimer) clearInterval(eventsTimer);
  pollEvents();
  eventsTimer = setInterval(pollEvents, 1200);
}

function buildElapsed(build: BuildSummary): string {
  if (build.started_at == null) return "";
  const endpoint =
    build.status === "running" ? Date.now() / 1000 : build.finished_at ?? build.started_at;
  return fmtDuration(endpoint - build.started_at);
}

function selectBuild(name: string): void {
  selected = null;
  selectedBuild = name;
  buildLogOffset = 0;
  toolQueues = {};
  toolCount = 0;
  if (eventsTimer) clearInterval(eventsTimer);
  const transcript = byId<HTMLDivElement>("transcript");
  transcript.innerHTML = `<div class="bubble build-log"></div>`;
  renderSidebar();
  updateBuildHeader();
  pollBuildLog();
  eventsTimer = setInterval(pollBuildLog, 800);
}

function updateBuildHeader(): void {
  if (!selectedBuild) return;
  const build = buildsCache.find((candidate) => candidate.name === selectedBuild);
  const header = byId<HTMLDivElement>("header");
  if (!build) {
    header.innerHTML = `<span class="title">${escapeHtml(selectedBuild)}</span>`;
    return;
  }
  const unit = build.current_unit ? `current ${build.current_unit}` : "waiting for compiler";
  header.innerHTML = `<span class="title">${escapeHtml(build.name)}</span>
    <span class="stat">${escapeHtml(build.target)}</span>
    <span class="stat">${escapeHtml(build.status)}</span>
    <span class="stat">${escapeHtml(build.phase)}</span>
    <span class="stat">${build.compiled_units} units</span>
    <span class="stat">${escapeHtml(unit)}</span>
    <span class="stat">${buildElapsed(build)}</span>`;
}

async function pollBuildLog(): Promise<void> {
  if (!selectedBuild) return;
  try {
    const response = await fetch(
      `/api/builds/${encodeURIComponent(selectedBuild)}/log?offset=${buildLogOffset}`,
    );
    const data: { text: string; offset: number } = await response.json();
    buildLogOffset = data.offset;
    if (data.text) {
      const transcript = byId<HTMLDivElement>("transcript");
      const log = transcript.querySelector<HTMLDivElement>(".build-log");
      if (log) {
        const stickToBottom =
          transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 40;
        log.textContent += stripAnsi(data.text).replace(/^::phase::.*(?:\r?\n|$)/gm, "");
        if (stickToBottom) transcript.scrollTop = transcript.scrollHeight;
      }
    }
    updateBuildHeader();
  } catch {
    // A just-created build may not have opened its log yet; retry next tick.
  }
}

function armStats(job: JobSummary): { arm: string; pass: number; fail: number; running: number; n: number }[] {
  const byArm = new Map<string, { arm: string; pass: number; fail: number; running: number; n: number }>();
  for (const trial of job.trials) {
    const arm = trial.agent_name || job.agent_name || "unknown";
    let row = byArm.get(arm);
    if (!row) {
      row = { arm, pass: 0, fail: 0, running: 0, n: 0 };
      byArm.set(arm, row);
    }
    row.n += 1;
    if (trial.reward != null) {
      if ((trial.reward || 0) > 0) row.pass += 1;
      else row.fail += 1;
    } else if (trial.status === "done" || trial.status === "errored") {
      row.fail += 1;
    } else {
      row.running += 1;
    }
  }
  return [...byArm.values()].sort((a, b) => a.arm.localeCompare(b.arm));
}

function renderJobOverview(jobName: string, opts: { preserveScroll?: boolean } = {}): void {
  if (!selected || selected.job !== jobName || selected.trial != null) return;
  const job = jobsCache.find((j) => j.name === jobName);
  const header = byId<HTMLDivElement>("header");
  const transcript = byId<HTMLDivElement>("transcript");
  if (!job) {
    header.innerHTML = `<span class="title">${escapeHtml(jobName)}</span>`;
    transcript.innerHTML = `<div class="empty">Job not found.</div>`;
    return;
  }

  const scored = job.trials.filter((t) => t.reward != null);
  const passed = scored.filter((t) => (t.reward || 0) > 0).length;
  const running = job.trials.filter((t) => t.status === "running").length;
  const progress = job.status === "running"
    ? `<span class="stat">${job.n_completed ?? 0}/${job.n_total ?? job.trials.length} done</span>`
    : "";

  header.innerHTML = `<span class="title">${escapeHtml(job.name)}</span>
    <span class="stat">${escapeHtml(job.model_name || "")}</span>
    <span class="stat">${escapeHtml(job.status)}</span>
    ${progress}
    <span class="stat">passed ${passed}/${scored.length}</span>
    <span class="stat">click a trial for its transcript</span>`;

  const scrollTop = opts.preserveScroll ? transcript.scrollTop : 0;
  const arms = armStats(job);

  const cards = [
    `<div class="overview-card"><div class="label">trials</div><div class="value">${job.trials.length}/${job.n_total ?? job.trials.length}</div></div>`,
    `<div class="overview-card"><div class="label">passed</div><div class="value verifier-ok">${passed}</div></div>`,
    `<div class="overview-card"><div class="label">failed</div><div class="value ${scored.length - passed ? "verifier-bad" : ""}">${scored.length - passed}</div></div>`,
    `<div class="overview-card"><div class="label">running</div><div class="value">${running}</div></div>`,
  ];
  for (const arm of arms) {
    const done = arm.pass + arm.fail;
    const rate = done ? `${arm.pass}/${done}` : "—";
    cards.push(
      `<div class="overview-card"><div class="label">${escapeHtml(arm.arm)}</div>` +
        `<div class="value">${rate}` +
        (arm.running ? ` <span style="color:var(--dim);font-size:12px">+${arm.running} run</span>` : "") +
        `</div></div>`,
    );
  }

  let rows = "";
  const sortedOverviewTrials = [...job.trials].sort((a, b) => trialSortPriority(a) - trialSortPriority(b));
  for (const trial of sortedOverviewTrials) {
    const reward =
      trial.reward != null ? String(trial.reward) : trial.status === "running" ? "—" : "—";
    const checks =
      trial.verifier && trial.verifier.total != null
        ? `${trial.verifier.passed ?? "?"}/${trial.verifier.total}`
        : "—";
    const dotClass = trialDotClass(trial);
    rows += `<tr data-trial="${escapeHtml(trial.name)}">
      <td><span class="dot ${dotClass}"></span></td>
      <td class="tname">${escapeHtml(trial.name)}</td>
      <td>${escapeHtml(trial.agent_name || "—")}</td>
      <td>${escapeHtml(trial.status)}</td>
      <td>${escapeHtml(reward)}</td>
      <td>${escapeHtml(checks)}</td>
      <td>${escapeHtml(trialElapsed(trial))}</td>
    </tr>`;
  }

  transcript.innerHTML = `<div class="overview">
    <div class="overview-summary">${cards.join("")}</div>
    <table class="overview-table">
      <thead><tr>
        <th></th><th>trial</th><th>agent</th><th>status</th><th>reward</th><th>checks</th><th>elapsed</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;

  for (const tr of transcript.querySelectorAll("tr[data-trial]")) {
    const name = (tr as HTMLElement).dataset.trial!;
    (tr as HTMLElement).onclick = () => selectTrial(job.name, name);
  }
  if (opts.preserveScroll) transcript.scrollTop = scrollTop;
}

function updateHeader(): void {
  if (!selected || !selected.trial) return;
  const job = jobsCache.find((j) => j.name === selected!.job);
  const trial = job && job.trials.find((t) => t.name === selected!.trial);
  const el = byId<HTMLDivElement>("header");
  el.innerHTML = `<span class="title">${escapeHtml(selected.trial)}</span>
    <span class="stat">${escapeHtml(job ? job.model_name || "" : "")}</span>
    <span class="stat" id="tool-count">${toolCount} tool calls</span>
    <span class="stat" id="elapsed-stat">${currentElapsed()}</span>
    <span class="stat" id="trial-status">${escapeHtml(trial ? trial.status : "")}</span>
    ${verifierStat(trial)}`;
}

function verifierStat(trial: TrialSummary | undefined): string {
  const v = trial && trial.verifier;
  if (!v || v.total == null) return "";
  const cls = v.passed === v.total ? "ok" : "bad";
  return `<span class="stat verifier-${cls}">${escapeHtml(v.passed)}/${escapeHtml(v.total)} checks</span>`;
}

// The verifier banner, kept as a live reference so it can be moved back to
// the end of the transcript as new events stream in.
let verifierBanner: HTMLDivElement | null = null;

/// Keeps the verifier result as the last thing in the transcript. It reports
/// what happened *after* the agent exited, so showing it above the agent's own
/// output puts it out of order, and placing it directly before "run ended:
/// completed" reads as a contradiction. The header's check tally is what makes
/// it visible without scrolling.
function keepVerifierLast(container: HTMLElement): void {
  if (verifierBanner) container.appendChild(verifierBanner);
}

function renderVerifierBanner(container: HTMLElement, trial: TrialSummary | undefined): void {
  verifierBanner = null;
  const v = trial && trial.verifier;
  if (!v || v.total == null) return;
  const b = document.createElement("div");
  const allPassed = v.passed === v.total;
  b.className = "banner " + (allPassed ? "end" : "error");
  if (allPassed) {
    b.textContent = `verifier: all ${v.total} checks passed`;
  } else {
    const lines = v.failures.map(
      (f) => `  ${f.name}\n      ${f.detail || "(no detail recorded)"}`,
    );
    b.textContent =
      `verifier: ${v.passed}/${v.total} checks passed, ${v.failures.length} failed\n` +
      lines.join("\n");
  }
  verifierBanner = b;
  container.appendChild(b);
}

function textNodeOrBubble(container: HTMLElement): HTMLDivElement {
  const last = container.lastElementChild as HTMLElement | null;
  if (last && last.classList.contains("bubble") && last.dataset.open === "1") {
    return last as HTMLDivElement;
  }
  const div = document.createElement("div");
  div.className = "bubble";
  div.dataset.open = "1";
  container.appendChild(div);
  return div;
}
function closeOpenBubble(container: HTMLElement): void {
  const last = container.lastElementChild as HTMLElement | null;
  if (last && last.classList.contains("bubble")) last.dataset.open = "0";
}

/// Shell is the tool people watch live: a foreground server hang is opaque
/// behind a collapsed summary, while a long `file_write` body is noise. Expand
/// shell when it is the newest tool call; leave write tools collapsed.
function isShellTool(name: string): boolean {
  return name === "shell" || name === "python";
}

function collapsePriorTools(container: HTMLElement): void {
  for (const el of container.querySelectorAll("details.tool")) {
    (el as HTMLDetailsElement).open = false;
  }
}

function renderToolUse(container: HTMLElement, ev: { name: string; text: string }): void {
  // Only the newest call should stay open. A previous shell that already
  // returned would otherwise leave several expanded blocks stacked up.
  collapsePriorTools(container);

  const details = document.createElement("details");
  details.className = "tool";
  details.dataset.toolName = ev.name;
  details.open = isShellTool(ev.name);
  const summary = document.createElement("summary");
  summary.innerHTML = `${escapeHtml(ev.name)} <span class="badge">running…</span>`;
  const body = document.createElement("div");
  body.className = "body";
  let input = ev.text || "";
  try {
    input = JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    // not JSON; show the raw string as-is
  }
  body.innerHTML = `<div class="section-label">input</div>${escapeHtml(stripAnsi(input))}`;
  details.appendChild(summary);
  details.appendChild(body);
  container.appendChild(details);
  closeOpenBubble(container);
  toolCount++;
  const q = toolQueues[ev.name] || (toolQueues[ev.name] = []);
  q.push(details);
}

function renderToolResult(container: HTMLElement, ev: BenchToolResultEvent): void {
  const q = toolQueues[ev.name];
  const details = q && q.length ? q.shift()! : null;
  if (!details) {
    renderToolUse(container, { name: ev.name, text: "(no matching call)" });
    return;
  }
  const summary = details.querySelector("summary")!;
  summary.innerHTML = `${escapeHtml(ev.name)} <span class="badge">done</span>`;
  const body = details.querySelector(".body")!;
  const resultDiv = document.createElement("div");
  resultDiv.innerHTML = `<div class="section-label">result</div>${escapeHtml(stripAnsi(ev.text || ""))}`;
  body.appendChild(resultDiv);

  // A completed shell that is still the newest call stays open so the input
  // (and result) remain visible until the next tool call arrives.
  const tools = container.querySelectorAll("details.tool");
  const isMostRecent = tools.length > 0 && tools[tools.length - 1] === details;
  details.open = isMostRecent && isShellTool(ev.name);
}

// Terminal output reaches us with its ANSI control sequences intact: colour
// codes, cursor moves, erase-line, the private "hide cursor" pair progress
// bars use. Rendered as text these show up as literal `[34mINFO` fragments
// with a replacement glyph where the ESC byte was, which is what a tool that
// colours its output (pip, twine, cargo) looks like in a transcript.
//
// Stripped rather than translated to colour: the value here is a readable
// transcript, and faithfully reproducing terminal rendering would mean
// implementing cursor addressing and line erasure, which progress bars rely
// on, for no real gain.
// A regex literal, not new RegExp("..."): building this from an escaped
// string needs every backslash doubled, and getting that wrong yields a
// pattern that only throws the first time it runs, which neither tsc nor
// the bundler catches. Covers CSI sequences (colour, cursor movement,
// erase-line, the show/hide-cursor pair progress bars use) and
// BEL-terminated OSC, which is every form these logs actually contain.
const ANSI_PATTERN =
  /\u001B\[[0-9;?]*[ -\/]*[@-~]|\u001B\][^\u0007]*\u0007/g;

function stripAnsi(s: string): string {
  return (s || "").replace(ANSI_PATTERN, "");
}

// Everything rendered here comes from an agent's log: model-authored prose,
// source code it wrote, raw tool arguments. That is untrusted markup as far
// as the page is concerned, so it must be escaped at every interpolation into
// innerHTML, not just the ones that look like they hold prose. A tool name of
// `usage: enc <input-file>` (a real case, from a swapped field in the emitting
// agent) rendered a live, focusable <input> into the transcript.
//
// Quotes are escaped too: some of these interpolations land inside an HTML
// attribute (title="..."), where &lt;/&gt; alone would not stop an attacker
// closing the attribute.
function escapeHtml(s: any): string {
  if (s == null) return "";
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c),
  );
}

function renderEvent(container: HTMLElement, ev: BenchEvent): void {
  switch (ev.type) {
    case "text": {
      const bubble = textNodeOrBubble(container);
      bubble.textContent += stripAnsi((ev as BenchTextEvent).text);
      break;
    }
    case "tool_use":
      renderToolUse(container, ev as BenchToolUseEvent);
      break;
    case "tool_result":
      renderToolResult(container, ev as BenchToolResultEvent);
      break;
    case "error": {
      closeOpenBubble(container);
      const b = document.createElement("div");
      b.className = "banner error";
      b.textContent = stripAnsi((ev as BenchErrorEvent).message || "error");
      container.appendChild(b);
      break;
    }
    case "run_end": {
      closeOpenBubble(container);
      const re = ev as BenchRunEndEvent;
      const b = document.createElement("div");
      b.className = "banner end";
      b.textContent = `run ended: ${re.status} (exit ${re.exitCode})`;
      container.appendChild(b);
      break;
    }
    case "run_start":
    case "final":
      break; // final duplicates the streamed text bubbles; run_start has nothing to show yet
    case "raw": {
      // Any line that is not JSON. Usually a stray warning on the same fd,
      // but a whole log in another format (a plain terminal capture, say)
      // arrives as nothing but these, so this is the path most likely to
      // carry raw terminal output and it needs the ANSI strip most.
      closeOpenBubble(container);
      const b = document.createElement("div");
      b.className = "bubble";
      b.style.color = "var(--dim)";
      b.textContent = stripAnsi((ev as BenchRawEvent).text || "");
      container.appendChild(b);
      break;
    }
    default: {
      // An unrecognized but valid JSON event type: still shown, just as a
      // raw dump, so a differently-shaped agent schema degrades instead of
      // silently vanishing.
      const b = document.createElement("div");
      b.className = "bubble";
      b.textContent = JSON.stringify(ev);
      container.appendChild(b);
    }
  }
}

async function pollEvents(): Promise<void> {
  if (!selected || !selected.trial) return;
  try {
    const res = await fetch(`/api/jobs/${selected.job}/trials/${selected.trial}/events?offset=${eventsOffset}`);
    const data: EventsResponse = await res.json();
    eventsOffset = data.offset;
    if (data.events.length) {
      const container = byId<HTMLDivElement>("transcript");
      const placeholder = container.querySelector(".empty");
      if (placeholder) placeholder.remove();
      const stickToBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
      for (const ev of data.events) renderEvent(container, ev);
      keepVerifierLast(container);
      if (stickToBottom) container.scrollTop = container.scrollHeight;
      const tc = document.getElementById("tool-count");
      if (tc) tc.textContent = `${toolCount} tool calls`;
    }
  } catch {
    // trial dir may not exist yet right after selection; next tick will find it
  }
  const es = document.getElementById("elapsed-stat");
  if (es) es.textContent = currentElapsed();
}

pollJobs();
setInterval(pollJobs, 4000);
