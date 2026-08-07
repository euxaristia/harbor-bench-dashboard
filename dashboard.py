#!/usr/bin/env python3
"""Local read-only dashboard for watching Harbor benchmark jobs as they run.

Serves a single HTML page plus a small JSON API that reads straight out of
a `jobs/` directory Harbor already writes to. Nothing here talks to Harbor,
Docker, or the network beyond the loopback interface: it just tails files
that already exist on disk, so it can watch a run that was started any
other way (this script, a bare `harbor run`, cron, whatever) as long as it
points at the same jobs directory.

The job/trial browsing (status, staleness detection, reward, elapsed time)
works for any Harbor job regardless of which agent produced it, since it
only reads Harbor's own `config.json` / `result.json` / `verifier/` files.

The transcript view is the one agent-specific part: it expects each
non-empty line of a trial's `agent/*.txt` log to be one JSON object with at
least a `"type"` field, matching the shape:

    {"type": "text", "text": "..."}
    {"type": "tool_use", "name": "...", "text": "<raw input>"}
    {"type": "tool_result", "name": "...", "text": "<result>"}
    {"type": "error", "message": "..."}
    {"type": "run_end", "status": "completed"|"error", "exitCode": 0}

tool_use/tool_result pairs are matched in the order they appear, per tool
name (a FIFO queue per name, not by any id, since not every agent's schema
has one). A line that isn't valid JSON, or a recognized `"type"` this
doesn't have a case for, still gets shown: as plain text or a raw JSON
dump respectively, rather than being dropped. So an agent that emits a
completely different schema is still watchable, just without the nice
tool-call bubbles.

The server is stdlib-only Python; running it needs nothing installed. The
client is TypeScript (dashboard.ts), compiled ahead of time to dashboard.js,
which this reads from disk and inlines into the page. Editing the client
needs bun (`bun build dashboard.ts --target=browser --format=iife
--outfile=dashboard.js`); running the server does not, since the compiled
output is committed alongside it.

Usage:
    python dashboard.py [--jobs-dir jobs] [--port 8787]
"""

from __future__ import annotations

import argparse
import datetime
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None


STALE_AFTER_SECONDS = 120


def _mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _last_activity_mtime(trial_dir: Path) -> float | None:
    # The most recently modified file anywhere under the trial is the best
    # available proxy for "is something still happening here": a genuinely
    # running trial keeps appending to its agent log (or, in its first
    # instant, at least has a freshly written lock.json), while a process
    # that died leaves everything frozen at whatever mtime it stopped at.
    newest = None
    for path in trial_dir.rglob("*"):
        m = _mtime(path)
        if m is not None and (newest is None or m > newest):
            newest = m
    return newest


def trial_summary(trial_dir: Path) -> dict:
    result = read_json(trial_dir / "result.json")
    exception_path = trial_dir / "exception.txt"
    agent_dir = trial_dir / "agent"
    agent_files = sorted(agent_dir.glob("*.txt")) if agent_dir.is_dir() else []
    agent_size = agent_files[0].stat().st_size if agent_files else 0

    reward = None
    reward_text = read_text(trial_dir / "verifier" / "reward.txt")
    if reward_text is not None:
        try:
            reward = float(reward_text)
        except ValueError:
            reward = None

    # `lock.json` is written the moment the trial is created, before the
    # environment even builds, so its mtime is the closest thing to a real
    # "started at" this trial has: the agent log doesn't exist yet at that
    # point, and not every agent's log schema carries a timestamp on every
    # line for this to read instead.
    started_at = _mtime(trial_dir / "lock.json")
    last_activity_at = _last_activity_mtime(trial_dir)
    stale = (
        last_activity_at is not None
        and time.time() - last_activity_at > STALE_AFTER_SECONDS
    )

    if result is not None:
        status = "done"
    elif exception_path.exists():
        status = "errored"
    elif stale:
        # No result.json and nothing on disk has changed in two minutes:
        # this covers both a process that crashed before writing its first
        # line and one that wrote real output for a while and then died
        # mid-run (its parent process crashed, the container was killed from
        # outside Harbor). Neither ever gets a result.json, so nothing else
        # distinguishes either from a trial that is genuinely still working.
        status = "stalled"
    else:
        status = "running"

    return {
        "name": trial_dir.name,
        "status": status,
        "agent_file": agent_files[0].name if agent_files else None,
        "agent_bytes": agent_size,
        "reward": reward,
        "exception": read_text(exception_path) if status == "errored" else None,
        # Both in epoch seconds so the client can compute "how long did/has
        # this actually taken" from real file activity instead of from
        # whenever someone happened to open the page.
        "started_at": started_at,
        "last_activity_at": last_activity_at,
    }


def _job_started_at(job_dir: Path) -> float:
    """Epoch seconds for when the job began, for ordering and grouping.

    Harbor names a job directory "YYYY-MM-DD__HH-MM-SS" by default, which is a
    reliable start time without touching the filesystem. A custom --job-name
    won't parse, so fall back to the directory's own creation time.

    Sorting on this rather than on the directory name matters: reverse
    alphabetical puts letters before digits, so a single job named
    "my-experiment" outranks every timestamped job forever and buries the run
    someone just started.
    """
    try:
        stamp = datetime.datetime.strptime(job_dir.name[:20], "%Y-%m-%d__%H-%M-%S")
        return stamp.timestamp()
    except ValueError:
        pass
    try:
        return job_dir.stat().st_ctime
    except OSError:
        return 0.0


def _job_date(job_dir: Path) -> str:
    started = _job_started_at(job_dir)
    if started <= 0.0:
        return "unknown"
    return datetime.date.fromtimestamp(started).isoformat()


def job_summary(job_dir: Path) -> dict:
    config = read_json(job_dir / "config.json") or {}
    result = read_json(job_dir / "result.json")
    agents = config.get("agents") or [{}]
    task_names = [
        name
        for dataset in config.get("datasets", [])
        for name in dataset.get("task_names", [])
    ]
    trials = sorted(
        (trial_summary(d) for d in job_dir.iterdir() if d.is_dir()),
        key=lambda t: t["name"],
    )
    stats = (result or {}).get("stats", {})
    if result and result.get("finished_at"):
        job_status = "done"
    elif any(t["status"] == "running" for t in trials):
        # At least one trial is genuinely still making progress, even if
        # Harbor's own top-level result.json for the whole job hasn't been
        # written yet (it only lands once every trial finishes).
        job_status = "running"
    else:
        # No trial is actually running and there's no result.json either:
        # the harbor process itself died (or was killed) before it could
        # write one, so nothing will ever mark this job "done". Showing
        # "running" here would contradict every trial underneath it.
        job_status = "stalled"
    return {
        "name": job_dir.name,
        "date": _job_date(job_dir),
        "status": job_status,
        "agent_name": agents[0].get("name"),
        "model_name": agents[0].get("model_name"),
        "task_names": task_names,
        "started_at": (result or {}).get("started_at"),
        "finished_at": (result or {}).get("finished_at"),
        "n_completed": stats.get("n_completed_trials"),
        "n_errored": stats.get("n_errored_trials"),
        "n_total": (result or {}).get("n_total_trials"),
        "trials": trials,
    }


def list_jobs(jobs_dir: Path) -> list[dict]:
    if not jobs_dir.is_dir():
        return []
    # Newest first by real start time. The directory name is only a tiebreak,
    # so two jobs created in the same second still order deterministically.
    job_dirs = sorted(
        (d for d in jobs_dir.iterdir() if d.is_dir()),
        key=lambda d: (_job_started_at(d), d.name),
        reverse=True,
    )
    return [job_summary(d) for d in job_dirs]


def tail_events(trial_dir: Path, offset: int) -> dict:
    agent_dir = trial_dir / "agent"
    files = sorted(agent_dir.glob("*.txt")) if agent_dir.is_dir() else []
    if not files:
        return {"events": [], "offset": 0}

    data = files[0].read_bytes()
    # A restarted or replaced log is shorter than the offset the client
    # already has; restart from the top rather than returning nothing
    # forever.
    if offset > len(data):
        offset = 0
    chunk = data[offset:]

    # Only complete lines are safe to parse: the agent process may be
    # mid-write on the last line, and a half-written JSON object is not
    # actually malformed, it just doesn't exist yet.
    last_newline = chunk.rfind(b"\n")
    if last_newline == -1:
        return {"events": [], "offset": offset}

    complete = chunk[: last_newline + 1]
    events = []
    for line in complete.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except ValueError:
            # A non-JSON line (a stray print from setup, a shell warning
            # that leaked onto the same fd) is still worth showing.
            events.append({"type": "raw", "text": line})
    return {"events": events, "offset": offset + len(complete)}


def trial_detail(trial_dir: Path) -> dict:
    summary = trial_summary(trial_dir)
    summary["result"] = read_json(trial_dir / "result.json")
    ctrf = read_json(trial_dir / "verifier" / "ctrf.json")
    summary["verifier_summary"] = (ctrf or {}).get("results", {}).get("summary")
    return summary


INDEX_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Harbor bench dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0d1117; --panel: #161b22; --border: #30363d;
    --text: #e6edf3; --dim: #8b949e; --accent: #58a6ff;
    --ok: #3fb950; --bad: #f85149; --warn: #d29922;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 13px/1.5 ui-monospace, "SF Mono", Consolas, monospace;
    background: var(--bg); color: var(--text); display: flex; height: 100vh;
  }
  #sidebar {
    width: 320px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--border);
    background: var(--panel);
  }
  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .job { border-bottom: 1px solid var(--border); }
  .job-head { padding: 10px 12px; }
  .job-head .name { font-weight: 600; }
  .job-head .meta { color: var(--dim); font-size: 11px; margin-top: 2px; }
  .trial {
    padding: 8px 12px 8px 22px; cursor: pointer; display: flex;
    align-items: center; gap: 8px; border-top: 1px solid var(--border);
  }
  .trial:hover { background: #1f2530; }
  .trial.selected { background: #1c2b3d; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.running { background: var(--warn); box-shadow: 0 0 6px var(--warn); animation: pulse 1.4s infinite; }
  .dot.done { background: var(--ok); }
  .dot.errored { background: var(--bad); }
  .dot.stalled { background: var(--dim); }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .trial .tname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .reward { font-size: 11px; color: var(--dim); }
  #header {
    padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--panel);
    display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap;
  }
  #header .title { font-weight: 600; font-size: 14px; }
  #header .stat { color: var(--dim); font-size: 12px; }
  #transcript { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .bubble { white-space: pre-wrap; margin: 4px 0 14px; max-width: 900px; }
  .tool {
    margin: 10px 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
    max-width: 900px;
  }
  .tool summary {
    cursor: pointer; padding: 6px 10px; background: #1c2128; color: var(--accent);
    font-weight: 600; list-style: none;
  }
  .tool summary::-webkit-details-marker { display: none; }
  .tool summary .badge {
    font-weight: normal; color: var(--dim); font-size: 11px; margin-left: 8px;
  }
  .tool .body { padding: 8px 10px; border-top: 1px solid var(--border); white-space: pre-wrap; }
  .tool .body .section-label { color: var(--dim); font-size: 11px; margin: 6px 0 2px; }
  .banner { padding: 8px 12px; border-radius: 6px; margin: 8px 0; max-width: 900px; }
  .banner.error { background: #3d1418; color: #ffb4ab; border: 1px solid var(--bad); }
  .banner.end { background: #132a1c; color: #9fe0ad; border: 1px solid var(--ok); white-space: pre-wrap; }
  .empty { color: var(--dim); padding: 40px; text-align: center; }
  a { color: var(--accent); }
</style>
</head>
<body>
<div id="sidebar"></div>
<div id="main">
  <div id="header"><span class="empty" style="padding:0">Select a trial</span></div>
  <div id="transcript"><div class="empty">Nothing selected yet. Pick a trial on the left.</div></div>
</div>
<script>__DASHBOARD_JS__</script>
</body>
</html>
"""


DASHBOARD_JS_PATH = Path(__file__).resolve().with_name("dashboard.js")


def _render_index() -> bytes:
    # Read fresh on every request rather than once at import time: this is a
    # local dev tool, and picking up a `bun build` re-run without needing to
    # restart the server is worth the cost of a few-KB file read per page
    # load. The client is hand-written TypeScript (dashboard.ts), compiled to
    # this file, so the fix for a broken page is `bun build ...`, not editing
    # this string.
    try:
        js = DASHBOARD_JS_PATH.read_text(encoding="utf-8")
    except OSError:
        js = (
            "document.body.textContent = "
            "'dashboard.js is missing. Run: bun build dashboard.ts "
            "--target=browser --format=iife --outfile=dashboard.js';"
        )
    return INDEX_HTML.replace("__DASHBOARD_JS__", js).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    jobs_dir: Path = Path("jobs")

    def log_message(self, fmt, *args):  # noqa: A002 - stdlib signature
        pass  # this is a local dev tool; the default access log is just noise

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - stdlib method name
        parts_url = urlsplit(self.path)
        parts = [p for p in parts_url.path.split("/") if p]
        query = parse_qs(parts_url.query)

        if not parts:
            body = _render_index()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parts[0] != "api":
            self.send_error(404)
            return

        # /api/jobs
        if parts[1:] == ["jobs"]:
            self._json(list_jobs(self.jobs_dir))
            return

        # /api/jobs/<job>/trials/<trial>/events?offset=N
        if len(parts) == 6 and parts[1] == "jobs" and parts[3] == "trials" and parts[5] == "events":
            job, trial = parts[2], parts[4]
            offset = int((query.get("offset") or ["0"])[0])
            trial_dir = self.jobs_dir / job / trial
            if not trial_dir.is_dir():
                self._json({"events": [], "offset": 0})
                return
            self._json(tail_events(trial_dir, offset))
            return

        # /api/jobs/<job>/trials/<trial>/result
        if len(parts) == 6 and parts[1] == "jobs" and parts[3] == "trials" and parts[5] == "result":
            job, trial = parts[2], parts[4]
            trial_dir = self.jobs_dir / job / trial
            if not trial_dir.is_dir():
                self.send_error(404)
                return
            self._json(trial_detail(trial_dir))
            return

        self.send_error(404)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs-dir", default="jobs")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    Handler.jobs_dir = Path(args.jobs_dir).resolve()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"watching {Handler.jobs_dir}")
    print(f"dashboard: http://127.0.0.1:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
