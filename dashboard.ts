// Client for the Harbor bench dashboard. Compiled to dashboard.js with bun
// (`bun build dashboard.ts --target=browser --format=iife --outfile=dashboard.js`)
// and served inline by dashboard.py, which reads the compiled output from
// disk rather than embedding hand-written JS in a Python string. Only
// editing this file requires bun; running the server does not.

interface TrialSummary {
  name: string;
  status: "running" | "done" | "errored" | "stalled";
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
let selected: { job: string; trial: string } | null = null;
let eventsOffset = 0;
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

// Anchored to real file timestamps from the server, not to whenever the
// page happened to load: a trial that stopped producing output hours ago
// must show a duration that stops too, not one that keeps climbing forever
// just because the dashboard tab is still open.
function currentElapsed(): string {
  if (!selected) return "";
  const job = jobsCache.find((j) => j.name === selected!.job);
  const trial = job && job.trials.find((t) => t.name === selected!.trial);
  if (!trial || trial.started_at == null) return "";
  const endpoint =
    trial.status === "running" ? Date.now() / 1000 : trial.last_activity_at ?? trial.started_at;
  return fmtDuration(endpoint - trial.started_at);
}

async function pollJobs(): Promise<void> {
  try {
    const res = await fetch("/api/jobs");
    jobsCache = await res.json();
    renderSidebar();
    // The header's status label is set once by updateHeader() when a trial
    // is selected and otherwise never touched again, unlike elapsed time and
    // tool count, which pollEvents() refreshes every 1.2s. Without this it
    // can go on saying "running" for a trial the sidebar (rebuilt from the
    // same fetch, a few lines up) already correctly shows as stalled or done.
    if (selected) {
      const job = jobsCache.find((j) => j.name === selected!.job);
      const trial = job && job.trials.find((t) => t.name === selected!.trial);
      const statusEl = document.getElementById("trial-status");
      if (statusEl && trial) statusEl.textContent = trial.status;
    }
    if (!selected && jobsCache.length) {
      // The newest job, not "whichever job anywhere in history still says
      // running": an old crashed attempt that never wrote a result.json
      // stays "running" forever, and it sorts no differently from a trial
      // that is genuinely active right now.
      const job = jobsCache[0];
      const trial = job.trials.find((t) => t.status === "running") ?? job.trials[0];
      if (trial) selectTrial(job.name, trial.name);
    }
  } catch {
    // server not up yet, or a job dir mid-write; retry next tick
  }
}

function renderSidebar(): void {
  const el = byId<HTMLDivElement>("sidebar");
  el.innerHTML = "";

  // Group by calendar date, preserving jobsCache's newest-first order both
  // across groups and within each one.
  const groups: { date: string; jobs: JobSummary[] }[] = [];
  const byDate = new Map<string, { date: string; jobs: JobSummary[] }>();
  for (const job of jobsCache) {
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
      head.className = "job-head";
      head.innerHTML = `<div class="name">${escapeHtml(job.name)}</div>
        <div class="meta">${escapeHtml(job.model_name || "")} &middot; ${escapeHtml(job.status)}
        ${job.n_completed != null ? ` &middot; ${job.n_completed}/${job.n_total} done` : ""}</div>`;
      jobEl.appendChild(head);
      for (const trial of job.trials) {
        const t = document.createElement("div");
        t.className =
          "trial" + (selected && selected.job === job.name && selected.trial === trial.name ? " selected" : "");
        const rewardText = trial.reward != null ? `reward ${trial.reward}` : "";
        t.innerHTML = `<span class="dot ${trial.status}"></span>
          <span class="tname" title="${escapeHtml(trial.name)}">${escapeHtml(trial.name)}</span>
          <span class="reward">${rewardText}</span>`;
        t.onclick = () => selectTrial(job.name, trial.name);
        jobEl.appendChild(t);
      }
      dateEl.appendChild(jobEl);
    }
    el.appendChild(dateEl);
  }
}

function selectTrial(job: string, trial: string): void {
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
  if (eventsTimer) clearInterval(eventsTimer);
  pollEvents();
  eventsTimer = setInterval(pollEvents, 1200);
}

function updateHeader(): void {
  if (!selected) return;
  const job = jobsCache.find((j) => j.name === selected!.job);
  const trial = job && job.trials.find((t) => t.name === selected!.trial);
  const el = byId<HTMLDivElement>("header");
  el.innerHTML = `<span class="title">${escapeHtml(selected.trial)}</span>
    <span class="stat">${escapeHtml(job ? job.model_name || "" : "")}</span>
    <span class="stat" id="tool-count">${toolCount} tool calls</span>
    <span class="stat" id="elapsed-stat">${currentElapsed()}</span>
    <span class="stat" id="trial-status">${trial ? trial.status : ""}</span>`;
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

function renderToolUse(container: HTMLElement, ev: { name: string; text: string }): void {
  const details = document.createElement("details");
  details.className = "tool";
  details.open = false;
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
  body.innerHTML = `<div class="section-label">input</div>${escapeHtml(input)}`;
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
  resultDiv.innerHTML = `<div class="section-label">result</div>${escapeHtml(ev.text || "")}`;
  body.appendChild(resultDiv);
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
function escapeHtml(s: string): string {
  return (s || "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c),
  );
}

function renderEvent(container: HTMLElement, ev: BenchEvent): void {
  switch (ev.type) {
    case "text": {
      const bubble = textNodeOrBubble(container);
      bubble.textContent += ev.text;
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
      b.textContent = (ev as BenchErrorEvent).message || "error";
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
      // A stray non-JSON line on the same fd (a warning printed to stderr,
      // most commonly) — real, worth showing, but not a structured event.
      closeOpenBubble(container);
      const b = document.createElement("div");
      b.className = "bubble";
      b.style.color = "var(--dim)";
      b.textContent = (ev as BenchRawEvent).text || "";
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
  if (!selected) return;
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
