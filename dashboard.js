(() => {
  // dashboard.ts
  function byId(id) {
    const el = document.getElementById(id);
    if (!el)
      throw new Error(`missing #${id}`);
    return el;
  }
  function localDateKey(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  var todayKey = localDateKey(new Date);
  var jobsCache = [];
  var selected = null;
  var eventsOffset = 0;
  var toolQueues = {};
  var eventsTimer = null;
  var toolCount = 0;
  var expandedDates = new Set([todayKey]);
  function fmtDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  function currentElapsed() {
    if (!selected)
      return "";
    const job = jobsCache.find((j) => j.name === selected.job);
    const trial = job && job.trials.find((t) => t.name === selected.trial);
    if (!trial || trial.started_at == null)
      return "";
    const endpoint = trial.status === "running" ? Date.now() / 1000 : trial.last_activity_at ?? trial.started_at;
    return fmtDuration(endpoint - trial.started_at);
  }
  async function pollJobs() {
    try {
      const res = await fetch("/api/jobs");
      jobsCache = await res.json();
      renderSidebar();
      if (selected) {
        const job = jobsCache.find((j) => j.name === selected.job);
        const trial = job && job.trials.find((t) => t.name === selected.trial);
        const statusEl = document.getElementById("trial-status");
        if (statusEl && trial)
          statusEl.textContent = trial.status;
      }
      if (!selected && jobsCache.length) {
        const job = jobsCache[0];
        const trial = job.trials.find((t) => t.status === "running") ?? job.trials[0];
        if (trial)
          selectTrial(job.name, trial.name);
      }
    } catch {}
  }
  function jobProgress(job) {
    if (job.n_completed == null || job.n_total == null)
      return "";
    let s = ` &middot; ${job.n_completed}/${job.n_total} done`;
    const unfinished = job.n_total - job.n_completed - (job.n_errored || 0);
    if (unfinished > 0 && job.status !== "running") {
      s += ` &middot; <span class="verifier-bad">${unfinished} unfinished</span>`;
    }
    if (job.n_errored)
      s += ` &middot; ${job.n_errored} errored`;
    return s;
  }
  function renderSidebar() {
    const el = byId("sidebar");
    el.innerHTML = "";
    const groups = [];
    const byDate = new Map;
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
        if (dateEl.open)
          expandedDates.add(group.date);
        else
          expandedDates.delete(group.date);
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
        ${jobProgress(job)}</div>`;
        jobEl.appendChild(head);
        for (const trial of job.trials) {
          const t = document.createElement("div");
          t.className = "trial" + (selected && selected.job === job.name && selected.trial === trial.name ? " selected" : "");
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
  function selectTrial(job, trial) {
    selected = { job, trial };
    eventsOffset = 0;
    toolQueues = {};
    toolCount = 0;
    const jobData = jobsCache.find((j) => j.name === job);
    const trialData = jobData && jobData.trials.find((t) => t.name === trial);
    const transcript = byId("transcript");
    if (trialData && trialData.status === "stalled" && !trialData.agent_bytes) {
      transcript.innerHTML = `<div class="empty">This trial never wrote any agent output and hasn't in over two minutes.
      It most likely crashed before the agent started (check trial.log / exception.txt in its job directory).</div>`;
    } else {
      transcript.innerHTML = `<div class="empty">Waiting for output…</div>`;
    }
    renderSidebar();
    updateHeader();
    renderVerifierBanner(transcript, trialData);
    if (eventsTimer)
      clearInterval(eventsTimer);
    pollEvents();
    eventsTimer = setInterval(pollEvents, 1200);
  }
  function updateHeader() {
    if (!selected)
      return;
    const job = jobsCache.find((j) => j.name === selected.job);
    const trial = job && job.trials.find((t) => t.name === selected.trial);
    const el = byId("header");
    el.innerHTML = `<span class="title">${escapeHtml(selected.trial)}</span>
    <span class="stat">${escapeHtml(job ? job.model_name || "" : "")}</span>
    <span class="stat" id="tool-count">${toolCount} tool calls</span>
    <span class="stat" id="elapsed-stat">${currentElapsed()}</span>
    <span class="stat" id="trial-status">${trial ? trial.status : ""}</span>
    ${verifierStat(trial)}`;
  }
  function verifierStat(trial) {
    const v = trial && trial.verifier;
    if (!v || v.total == null)
      return "";
    const cls = v.passed === v.total ? "ok" : "bad";
    return `<span class="stat verifier-${cls}">${v.passed}/${v.total} checks</span>`;
  }
  var verifierBanner = null;
  function keepVerifierLast(container) {
    if (verifierBanner)
      container.appendChild(verifierBanner);
  }
  function renderVerifierBanner(container, trial) {
    verifierBanner = null;
    const v = trial && trial.verifier;
    if (!v || v.total == null)
      return;
    const b = document.createElement("div");
    const allPassed = v.passed === v.total;
    b.className = "banner " + (allPassed ? "end" : "error");
    if (allPassed) {
      b.textContent = `verifier: all ${v.total} checks passed`;
    } else {
      const lines = v.failures.map((f) => `  ${f.name}
      ${f.detail || "(no detail recorded)"}`);
      b.textContent = `verifier: ${v.passed}/${v.total} checks passed, ${v.failures.length} failed
` + lines.join(`
`);
    }
    verifierBanner = b;
    container.appendChild(b);
  }
  function textNodeOrBubble(container) {
    const last = container.lastElementChild;
    if (last && last.classList.contains("bubble") && last.dataset.open === "1") {
      return last;
    }
    const div = document.createElement("div");
    div.className = "bubble";
    div.dataset.open = "1";
    container.appendChild(div);
    return div;
  }
  function closeOpenBubble(container) {
    const last = container.lastElementChild;
    if (last && last.classList.contains("bubble"))
      last.dataset.open = "0";
  }
  function renderToolUse(container, ev) {
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
    } catch {}
    body.innerHTML = `<div class="section-label">input</div>${escapeHtml(stripAnsi(input))}`;
    details.appendChild(summary);
    details.appendChild(body);
    container.appendChild(details);
    closeOpenBubble(container);
    toolCount++;
    const q = toolQueues[ev.name] || (toolQueues[ev.name] = []);
    q.push(details);
  }
  function renderToolResult(container, ev) {
    const q = toolQueues[ev.name];
    const details = q && q.length ? q.shift() : null;
    if (!details) {
      renderToolUse(container, { name: ev.name, text: "(no matching call)" });
      return;
    }
    const summary = details.querySelector("summary");
    summary.innerHTML = `${escapeHtml(ev.name)} <span class="badge">done</span>`;
    const body = details.querySelector(".body");
    const resultDiv = document.createElement("div");
    resultDiv.innerHTML = `<div class="section-label">result</div>${escapeHtml(stripAnsi(ev.text || ""))}`;
    body.appendChild(resultDiv);
  }
  var ANSI_PATTERN = /\u001B\[[0-9;?]*[ -\/]*[@-~]|\u001B\][^\u0007]*\u0007/g;
  function stripAnsi(s) {
    return (s || "").replace(ANSI_PATTERN, "");
  }
  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
  }
  function renderEvent(container, ev) {
    switch (ev.type) {
      case "text": {
        const bubble = textNodeOrBubble(container);
        bubble.textContent += stripAnsi(ev.text);
        break;
      }
      case "tool_use":
        renderToolUse(container, ev);
        break;
      case "tool_result":
        renderToolResult(container, ev);
        break;
      case "error": {
        closeOpenBubble(container);
        const b = document.createElement("div");
        b.className = "banner error";
        b.textContent = stripAnsi(ev.message || "error");
        container.appendChild(b);
        break;
      }
      case "run_end": {
        closeOpenBubble(container);
        const re = ev;
        const b = document.createElement("div");
        b.className = "banner end";
        b.textContent = `run ended: ${re.status} (exit ${re.exitCode})`;
        container.appendChild(b);
        break;
      }
      case "run_start":
      case "final":
        break;
      case "raw": {
        closeOpenBubble(container);
        const b = document.createElement("div");
        b.className = "bubble";
        b.style.color = "var(--dim)";
        b.textContent = stripAnsi(ev.text || "");
        container.appendChild(b);
        break;
      }
      default: {
        const b = document.createElement("div");
        b.className = "bubble";
        b.textContent = JSON.stringify(ev);
        container.appendChild(b);
      }
    }
  }
  async function pollEvents() {
    if (!selected)
      return;
    try {
      const res = await fetch(`/api/jobs/${selected.job}/trials/${selected.trial}/events?offset=${eventsOffset}`);
      const data = await res.json();
      eventsOffset = data.offset;
      if (data.events.length) {
        const container = byId("transcript");
        const placeholder = container.querySelector(".empty");
        if (placeholder)
          placeholder.remove();
        const stickToBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
        for (const ev of data.events)
          renderEvent(container, ev);
        keepVerifierLast(container);
        if (stickToBottom)
          container.scrollTop = container.scrollHeight;
        const tc = document.getElementById("tool-count");
        if (tc)
          tc.textContent = `${toolCount} tool calls`;
      }
    } catch {}
    const es = document.getElementById("elapsed-stat");
    if (es)
      es.textContent = currentElapsed();
  }
  pollJobs();
  setInterval(pollJobs, 4000);
})();
