# harbor-bench-dashboard

A local, read-only web UI for watching [Harbor](https://harborframework.com)
benchmark jobs as they run, instead of reading `jobs/<name>/*/agent/*.txt`
by hand or waiting for the run to finish before you find out it looped for
an hour.

The server (`main.go`) is a dependency-free Go program. It reads the
`jobs/` directory Harbor already writes to and
serves a page that polls for updates, so it works with a run started any
way at all (this script, a bare `harbor run`, a cron job) as long as it
points at the same jobs directory.

The client (`dashboard.ts`) is TypeScript, compiled ahead of time with
[bun](https://bun.sh) to the `dashboard.js` this repo ships. You only need
bun if you're editing the client.

## Usage

```bash
go run . --jobs-dir jobs --builds-dir builds --port 8787
```

Or build a standalone executable once:

```bash
go build .
./harbor-bench-dashboard --jobs-dir jobs --builds-dir builds --port 8787
```

Then open `http://127.0.0.1:8787/`. The sidebar groups jobs by calendar
date, today expanded and every other day collapsed one click away, newest
job first within each day, and auto-selects the most recent trial. Clicking
a trial streams its transcript live.

`--builds-dir` is optional. By default the dashboard watches a `builds/`
directory beside the selected `jobs/` directory. A build appears as soon as
its producer creates `<build>/meta.json`; `<build>/build.log` is streamed into
the detail pane, with the current phase, crate, compiled-unit count, status,
and elapsed time kept live in the header.

Binds to `127.0.0.1` only.

## Editing the client

```bash
bun build dashboard.ts --target=browser --format=iife --outfile=dashboard.js
```

Commit the regenerated `dashboard.js` alongside your `dashboard.ts` change;
the server reads it from disk on every request, so a stale compiled file is
the one way to make the two drift.

## What it shows

- **Job and trial status**: running, done, errored, or `stalled`, a trial
  with no `result.json` and nothing written to disk in the last ten
  minutes, which is what a crashed harness process looks like from the
  outside (it never gets a proper result, so nothing else distinguishes it
  from one that's still actually working).
- **Elapsed time**, computed from real file timestamps (`lock.json`'s mtime
  as the start, the most recently modified file as the end), not from when
  you happened to open the page. A trial that stopped hours ago shows a
  duration that stops too.
- **Reward**, once the verifier writes one.
- **A live transcript**, if the trial's agent log is newline-delimited JSON.
- **Live build output**, including phase changes and each Cargo compile line,
  when a build publishes `meta.json` and `build.log` in the builds directory.

## The transcript schema

The job/trial browsing works for any agent, since it only reads Harbor's
own files. The transcript view is the one part that's agent-specific: it
renders a trial's `agent/*.txt` log nicely if each line is a JSON object
shaped like one of these:

```json
{"type": "text", "text": "..."}
{"type": "tool_use", "name": "...", "text": "<raw input>"}
{"type": "tool_result", "name": "...", "text": "<result>"}
{"type": "error", "message": "..."}
{"type": "run_end", "status": "completed", "exitCode": 0}
```

`tool_use`/`tool_result` pairs are matched in the order they appear, per
tool name (a FIFO queue, not an id, since not every schema has one).

A line that isn't valid JSON, or a recognized event without a case above,
is still shown, as plain text or a raw JSON dump, rather than dropped. So
an agent with a different log format is still watchable, just without the
nice collapsible tool-call blocks.

## License

MIT, see [LICENSE](LICENSE).
