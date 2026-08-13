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
  function compactNumber(value) {
    return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
  }
  function formatCost(value) {
    if (!value)
      return "$0";
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
  }
  function usageText(usage) {
    if (!usage)
      return "0 tokens · $0";
    return `${compactNumber(usage.total_tokens)} tokens · ${formatCost(usage.estimated_cost_usd)}`;
  }
  var todayKey = localDateKey(new Date);
  var stateKey = "harbor-bench-dashboard-state-v1";
  function loadPersistedState() {
    try {
      const value = JSON.parse(localStorage.getItem(stateKey) || "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }
  var persistedState = loadPersistedState();
  var persistedSelection = persistedState.selected;
  var initialSelected = persistedSelection && typeof persistedSelection.job === "string" && (typeof persistedSelection.trial === "string" || persistedSelection.trial === null) ? persistedSelection : null;
  var jobsCache = [];
  var buildsCache = [];
  var selected = initialSelected;
  var selectedBuild = typeof persistedState.selectedBuild === "string" ? persistedState.selectedBuild : null;
  var eventsOffset = 0;
  var buildLogOffset = 0;
  var toolQueues = {};
  var eventsTimer = null;
  var toolCount = 0;
  var modelTextByBubble = new WeakMap;
  var maxModelBubbleChars = 32000;
  var maxToolTextChars = 16000;
  var sidebarVisible = typeof persistedState.sidebarVisible === "boolean" ? persistedState.sidebarVisible : true;
  var explorerContextVisible = false;
  var fileExplorerVisible = typeof persistedState.fileExplorerVisible === "boolean" ? persistedState.fileExplorerVisible : true;
  var buildsExpanded = typeof persistedState.buildsExpanded === "boolean" ? persistedState.buildsExpanded : true;
  var editedFiles = new Map;
  var expandedDates = new Set(Array.isArray(persistedState.expandedDates) ? persistedState.expandedDates.filter((date) => typeof date === "string") : [todayKey]);
  function fmtDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  var hideJunkRuns = typeof persistedState.hideJunkRuns === "boolean" ? persistedState.hideJunkRuns : true;
  var persistedSelectionApplied = false;
  function savePersistedState() {
    try {
      localStorage.setItem(stateKey, JSON.stringify({
        selected,
        selectedBuild,
        sidebarVisible,
        fileExplorerVisible,
        buildsExpanded,
        expandedDates: [...expandedDates],
        hideJunkRuns
      }));
    } catch {}
  }
  function isJunkJob(job) {
    if (job.status === "running")
      return false;
    if (job.trials.some((t) => t.status === "running"))
      return false;
    const completed = job.n_completed ?? 0;
    if (completed > 0)
      return false;
    const hasPass = job.trials.some((t) => t.reward != null && t.reward > 0);
    if (hasPass)
      return false;
    return true;
  }
  function trialDotClass(trial) {
    if (trial.status === "stalled")
      return "stalled";
    if (trial.status === "errored")
      return "errored";
    if (trial.reward != null && trial.reward <= 0)
      return "errored";
    if (trial.exception)
      return "errored";
    return trial.status;
  }
  function trialSortPriority(trial) {
    if (trial.status === "running")
      return 0;
    if (trial.reward != null && trial.reward > 0)
      return 1;
    if (trial.status === "stalled")
      return 3;
    return 2;
  }
  function trialElapsed(trial) {
    if (trial.started_at == null)
      return "";
    const endpoint = trial.status === "running" ? Date.now() / 1000 : trial.last_activity_at ?? trial.started_at;
    return fmtDuration(endpoint - trial.started_at);
  }
  function currentElapsed() {
    if (!selected || !selected.trial)
      return "";
    const job = jobsCache.find((j) => j.name === selected.job);
    const trial = job && job.trials.find((t) => t.name === selected.trial);
    if (!trial)
      return "";
    return trialElapsed(trial);
  }
  async function pollJobs() {
    try {
      const [jobsResponse, buildsResponse] = await Promise.all([
        fetch("/api/jobs"),
        fetch("/api/builds")
      ]);
      jobsCache = await jobsResponse.json();
      buildsCache = await buildsResponse.json();
      let clearedMissingSelection = false;
      if (selectedBuild && !buildsCache.some((build) => build.name === selectedBuild)) {
        selectedBuild = null;
        clearedMissingSelection = true;
      }
      if (selected) {
        const job = jobsCache.find((candidate) => candidate.name === selected.job);
        const trialExists = selected.trial === null || job?.trials.some((trial) => trial.name === selected.trial);
        if (!job || !trialExists) {
          selected = null;
          clearedMissingSelection = true;
        }
      }
      if (selected && selectedBuild) {
        selected = null;
        clearedMissingSelection = true;
      }
      if (clearedMissingSelection)
        savePersistedState();
      if (!persistedSelectionApplied) {
        persistedSelectionApplied = true;
        if (selectedBuild) {
          selectBuild(selectedBuild);
          return;
        }
        if (selected) {
          if (selected.trial)
            selectTrial(selected.job, selected.trial);
          else
            selectJob(selected.job);
          return;
        }
      }
      renderSidebar();
      if (selected) {
        if (selected.trial) {
          const job = jobsCache.find((j) => j.name === selected.job);
          const trial = job && job.trials.find((t) => t.name === selected.trial);
          const statusEl = document.getElementById("trial-status");
          if (statusEl && trial)
            statusEl.textContent = trial.status;
          const usageEl = document.getElementById("trial-usage");
          if (usageEl && trial)
            usageEl.textContent = usageText(trial.usage);
        } else {
          renderJobOverview(selected.job, { preserveScroll: true });
        }
      }
      if (selectedBuild)
        updateBuildHeader();
      if (!selected && !selectedBuild) {
        const runningBuild = buildsCache.find((build) => build.status === "running");
        if (runningBuild) {
          selectBuild(runningBuild.name);
          return;
        }
      }
      if (!selected && !selectedBuild && jobsCache.length) {
        selectJob(jobsCache[0].name);
      }
    } catch {}
  }
  function jobProgress(job) {
    if (job.n_completed == null || job.n_total == null)
      return "";
    let s = job.status === "running" ? ` &middot; ${job.n_completed}/${job.n_total} done` : "";
    const scored = job.trials.filter((t) => t.status !== "running");
    const stalled = job.trials.filter((t) => t.status === "stalled").length;
    const unfinished = job.n_total - job.n_completed - (job.n_errored || 0) - stalled;
    if (scored.length) {
      const passed = scored.filter((t) => (t.reward || 0) > 0).length;
      const cls = passed > 0 ? "verifier-ok" : "verifier-bad";
      s += ` &middot; <span class="${cls}">passed ${passed}/${scored.length}</span>`;
    }
    if (unfinished > 0 && job.status !== "running") {
      s += ` &middot; <span class="verifier-bad">${unfinished} unfinished</span>`;
    }
    if (stalled > 0)
      s += ` &middot; ${stalled} stalled`;
    if (job.n_errored)
      s += ` &middot; ${job.n_errored} errored`;
    return s;
  }
  function renderSidebar() {
    const el = byId("sidebar");
    el.innerHTML = "";
    const junkCount = jobsCache.filter(isJunkJob).length;
    const visibleJobs = jobsCache.filter((j) => !hideJunkRuns || !isJunkJob(j));
    const filterBar = document.createElement("div");
    filterBar.className = "sidebar-filter";
    filterBar.innerHTML = `<label><input type="checkbox" id="hide-junk-toggle" ${hideJunkRuns ? "checked" : ""} /> Hide empty runs</label>
    <span class="junk-count">${junkCount ? `(${junkCount} hidden)` : ""}</span>`;
    const toggleInput = filterBar.querySelector("#hide-junk-toggle");
    if (toggleInput) {
      toggleInput.onchange = () => {
        hideJunkRuns = toggleInput.checked;
        savePersistedState();
        renderSidebar();
      };
    }
    el.appendChild(filterBar);
    if (buildsCache.length) {
      const buildsGroup = document.createElement("details");
      buildsGroup.className = "date-group";
      buildsGroup.open = buildsExpanded;
      buildsGroup.ontoggle = () => {
        buildsExpanded = buildsGroup.open;
        savePersistedState();
      };
      const summary = document.createElement("summary");
      summary.className = "date-head";
      summary.textContent = `Builds — ${buildsCache.length}`;
      buildsGroup.appendChild(summary);
      for (const build of buildsCache) {
        const row = document.createElement("div");
        row.className = "trial" + (selectedBuild === build.name ? " selected" : "");
        const dotClass = build.status === "failed" ? "errored" : build.status === "succeeded" ? "done" : "running";
        const detail = build.status === "running" ? build.phase : build.status;
        row.innerHTML = `<span class="dot ${dotClass}"></span>
        <span class="tname" title="${escapeHtml(build.name)}">${escapeHtml(build.name)}</span>
        <span class="reward">${escapeHtml(detail)}</span>`;
        row.onclick = () => selectBuild(build.name);
        buildsGroup.appendChild(row);
      }
      el.appendChild(buildsGroup);
    }
    const groups = [];
    const byDate = new Map;
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
        if (dateEl.open)
          expandedDates.add(group.date);
        else
          expandedDates.delete(group.date);
        savePersistedState();
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
        ${jobProgress(job)} &middot; ${escapeHtml(usageText(job.usage))}</div>`;
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
            t.className = "trial" + (selected && selected.job === job.name && selected.trial === trial.name ? " selected" : "");
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
  function selectJob(job) {
    selectedBuild = null;
    selected = { job, trial: null };
    savePersistedState();
    eventsOffset = 0;
    toolQueues = {};
    toolCount = 0;
    resetFileExplorer(false);
    if (eventsTimer) {
      clearInterval(eventsTimer);
      eventsTimer = null;
    }
    renderSidebar();
    renderJobOverview(job);
  }
  function selectTrial(job, trial) {
    selectedBuild = null;
    selected = { job, trial };
    savePersistedState();
    eventsOffset = 0;
    toolQueues = {};
    toolCount = 0;
    resetFileExplorer(true);
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
  function buildElapsed(build) {
    if (build.started_at == null)
      return "";
    const endpoint = build.status === "running" ? Date.now() / 1000 : build.finished_at ?? build.started_at;
    return fmtDuration(endpoint - build.started_at);
  }
  function selectBuild(name) {
    selected = null;
    selectedBuild = name;
    savePersistedState();
    buildLogOffset = 0;
    toolQueues = {};
    toolCount = 0;
    resetFileExplorer(false);
    if (eventsTimer)
      clearInterval(eventsTimer);
    const transcript = byId("transcript");
    transcript.innerHTML = `<div class="bubble build-log"></div>`;
    renderSidebar();
    updateBuildHeader();
    pollBuildLog();
    eventsTimer = setInterval(pollBuildLog, 800);
  }
  function updateBuildHeader() {
    if (!selectedBuild)
      return;
    const build = buildsCache.find((candidate) => candidate.name === selectedBuild);
    const header = byId("header");
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
  async function pollBuildLog() {
    if (!selectedBuild)
      return;
    try {
      const response = await fetch(`/api/builds/${encodeURIComponent(selectedBuild)}/log?offset=${buildLogOffset}`);
      const data = await response.json();
      buildLogOffset = data.offset;
      if (data.text) {
        const transcript = byId("transcript");
        const log = transcript.querySelector(".build-log");
        if (log) {
          const stickToBottom = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 40;
          log.textContent += stripAnsi(data.text).replace(/^::phase::.*(?:\r?\n|$)/gm, "");
          if (stickToBottom)
            transcript.scrollTop = transcript.scrollHeight;
        }
      }
      updateBuildHeader();
    } catch {}
  }
  function armStats(job) {
    const byArm = new Map;
    for (const trial of job.trials) {
      const arm = trial.agent_name || job.agent_name || "unknown";
      let row = byArm.get(arm);
      if (!row) {
        row = { arm, pass: 0, fail: 0, running: 0, n: 0 };
        byArm.set(arm, row);
      }
      row.n += 1;
      if (trial.reward != null) {
        if ((trial.reward || 0) > 0)
          row.pass += 1;
        else
          row.fail += 1;
      } else if (trial.status !== "running") {
        row.fail += 1;
      } else {
        row.running += 1;
      }
    }
    return [...byArm.values()].sort((a, b) => a.arm.localeCompare(b.arm));
  }
  function renderJobOverview(jobName, opts = {}) {
    if (!selected || selected.job !== jobName || selected.trial != null)
      return;
    const job = jobsCache.find((j) => j.name === jobName);
    const header = byId("header");
    const transcript = byId("transcript");
    if (!job) {
      header.innerHTML = `<span class="title">${escapeHtml(jobName)}</span>`;
      transcript.innerHTML = `<div class="empty">Job not found.</div>`;
      return;
    }
    const scored = job.trials.filter((t) => t.status !== "running");
    const passed = scored.filter((t) => (t.reward || 0) > 0).length;
    const running = job.trials.filter((t) => t.status === "running").length;
    const progress = job.status === "running" ? `<span class="stat">${job.n_completed ?? 0}/${job.n_total ?? job.trials.length} done</span>` : "";
    header.innerHTML = `<span class="title">${escapeHtml(job.name)}</span>
    <span class="stat">${escapeHtml(job.model_name || "")}</span>
    <span class="stat">${escapeHtml(job.status)}</span>
    ${progress}
    <span class="stat">passed ${passed}/${scored.length}</span>
    <span class="stat">${escapeHtml(usageText(job.usage))}</span>
    <span class="stat">click a trial for its transcript</span>`;
    const scrollTop = opts.preserveScroll ? transcript.scrollTop : 0;
    const arms = armStats(job);
    const cards = [
      `<div class="overview-card"><div class="label">trials</div><div class="value">${job.trials.length}/${job.n_total ?? job.trials.length}</div></div>`,
      `<div class="overview-card"><div class="label">passed</div><div class="value verifier-ok">${passed}</div></div>`,
      `<div class="overview-card"><div class="label">failed</div><div class="value ${scored.length - passed ? "verifier-bad" : ""}">${scored.length - passed}</div></div>`,
      `<div class="overview-card"><div class="label">running</div><div class="value">${running}</div></div>`,
      `<div class="overview-card"><div class="label">tokens</div><div class="value">${compactNumber(job.usage.total_tokens)}</div></div>`,
      `<div class="overview-card"><div class="label">cached input</div><div class="value">${compactNumber(job.usage.cache_read_tokens)}</div></div>`,
      `<div class="overview-card"><div class="label">estimated cost</div><div class="value">${formatCost(job.usage.estimated_cost_usd)}</div></div>`
    ];
    for (const arm of arms) {
      const done = arm.pass + arm.fail;
      const rate = done ? `${arm.pass}/${done}` : "—";
      cards.push(`<div class="overview-card"><div class="label">${escapeHtml(arm.arm)}</div>` + `<div class="value">${rate}` + (arm.running ? ` <span style="color:var(--dim);font-size:12px">+${arm.running} run</span>` : "") + `</div></div>`);
    }
    let rows = "";
    const sortedOverviewTrials = [...job.trials].sort((a, b) => trialSortPriority(a) - trialSortPriority(b));
    for (const trial of sortedOverviewTrials) {
      const reward = trial.reward != null ? String(trial.reward) : trial.status === "running" ? "—" : "—";
      const checks = trial.verifier && trial.verifier.total != null ? `${trial.verifier.passed ?? "?"}/${trial.verifier.total}` : "—";
      const dotClass = trialDotClass(trial);
      rows += `<tr data-trial="${escapeHtml(trial.name)}">
      <td><span class="dot ${dotClass}"></span></td>
      <td class="tname">${escapeHtml(trial.name)}</td>
      <td>${escapeHtml(trial.agent_name || "—")}</td>
      <td>${escapeHtml(trial.status)}</td>
      <td>${escapeHtml(reward)}</td>
      <td>${escapeHtml(checks)}</td>
      <td title="${trial.usage.input_tokens} input, ${trial.usage.cache_read_tokens} cached, ${trial.usage.output_tokens} output">${compactNumber(trial.usage.total_tokens)}</td>
      <td>${formatCost(trial.usage.estimated_cost_usd)}</td>
      <td>${escapeHtml(trialElapsed(trial))}</td>
    </tr>`;
    }
    transcript.innerHTML = `<div class="overview">
    <div class="overview-summary">${cards.join("")}</div>
    <table class="overview-table">
      <thead><tr>
        <th></th><th>trial</th><th>agent</th><th>status</th><th>reward</th><th>checks</th><th>tokens</th><th>cost</th><th>elapsed</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
    for (const tr of transcript.querySelectorAll("tr[data-trial]")) {
      const name = tr.dataset.trial;
      tr.onclick = () => selectTrial(job.name, name);
    }
    if (opts.preserveScroll)
      transcript.scrollTop = scrollTop;
  }
  function updateHeader() {
    if (!selected || !selected.trial)
      return;
    const job = jobsCache.find((j) => j.name === selected.job);
    const trial = job && job.trials.find((t) => t.name === selected.trial);
    const el = byId("header");
    el.innerHTML = `<span class="title">${escapeHtml(selected.trial)}</span>
    <span class="stat">${escapeHtml(job ? job.model_name || "" : "")}</span>
    <span class="stat" id="tool-count">${toolCount} tool calls</span>
    <span class="stat" id="elapsed-stat">${currentElapsed()}</span>
    <span class="stat" id="trial-status">${trial ? trial.status : ""}</span>
    <span class="stat" id="trial-usage">${escapeHtml(usageText(trial?.usage))}</span>
    ${verifierStat(trial)}`;
  }
  function verifierStat(trial) {
    const v = trial && trial.verifier;
    if (!v || v.total == null)
      return "";
    const cls = v.passed === v.total ? "ok" : "bad";
    return `<span class="stat verifier-${cls}">${escapeHtml(String(v.passed ?? ""))}/${escapeHtml(String(v.total ?? ""))} checks</span>`;
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
  function boundedTail(text, limit) {
    if (text.length <= limit)
      return text;
    return `[Earlier output omitted from the live view. Full output remains on disk.]

${text.slice(-limit)}`;
  }
  function closeOpenBubble(container) {
    const last = container.lastElementChild;
    if (last && last.classList.contains("bubble"))
      last.dataset.open = "0";
  }
  function isShellTool(name) {
    return name === "shell" || name === "python";
  }
  function collapsePriorTools(container) {
    for (const el of container.querySelectorAll("details.tool")) {
      el.open = false;
    }
  }
  function renderToolUse(container, ev) {
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
    } catch {}
    body.innerHTML = `<div class="section-label">input</div>${escapeHtml(boundedTail(stripAnsi(input), maxToolTextChars))}`;
    details.appendChild(summary);
    details.appendChild(body);
    container.appendChild(details);
    trackEditedFiles(ev, details);
    closeOpenBubble(container);
    toolCount++;
    const q = toolQueues[ev.name] || (toolQueues[ev.name] = []);
    q.push(details);
  }
  function resetFileExplorer(visible) {
    editedFiles = new Map;
    explorerContextVisible = visible;
    applyPanelVisibility();
    renderFileExplorer();
  }
  function applyPanelVisibility() {
    byId("sidebar").classList.toggle("hidden", !sidebarVisible);
    byId("file-explorer").classList.toggle("hidden", !explorerContextVisible || !fileExplorerVisible);
  }
  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.repeat)
      return;
    const key = event.key.toLowerCase();
    if (key === "b" && !event.altKey) {
      event.preventDefault();
      sidebarVisible = !sidebarVisible;
      savePersistedState();
      applyPanelVisibility();
    }
    if (key === "b" && event.altKey) {
      event.preventDefault();
      fileExplorerVisible = !fileExplorerVisible;
      savePersistedState();
      applyPanelVisibility();
    }
  });
  function normalizedFilePath(path) {
    const cleaned = path.trim().replace(/^['"]|['"]$/g, "");
    if (!cleaned || cleaned === "/" || cleaned.endsWith("/"))
      return null;
    return cleaned.replace(/\\/g, "/");
  }
  function pathsWrittenByTool(ev) {
    let input = {};
    try {
      input = JSON.parse(ev.text || "");
    } catch {
      return [];
    }
    const paths = new Set;
    const add = (path) => {
      if (typeof path !== "string")
        return;
      const normalized = normalizedFilePath(path);
      if (normalized)
        paths.add(normalized);
    };
    const directWriteTools = new Set(["file_write", "write_file", "file_edit", "edit_file", "apply_patch"]);
    if (directWriteTools.has(ev.name))
      add(input.file_path ?? input.path);
    const source = [input.command, input.code, input.patch].filter((value) => typeof value === "string").join(`
`);
    const patterns = [
      /open\(\s*["']([^"']+)["']\s*,\s*["'][^"']*[wax+]/g,
      /Path\(\s*["']([^"']+)["']\s*\)\.write_(?:text|bytes)/g,
      /\*\*\* (?:Add|Update) File:\s*([^\r\n]+)/g,
      /(?:^|[;&|]\s*|\s)(?:>>?|tee(?:\s+-a)?)\s*["']?([^\s"';&|]+)/gm,
      /\bdd\b[^\r\n;&|]*\bof=([^\s;&|]+)/g
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern))
        add(match[1]);
    }
    return [...paths];
  }
  function trackEditedFiles(ev, tool) {
    for (const path of pathsWrittenByTool(ev)) {
      editedFiles.set(path, { path, operation: ev.name, tool });
    }
    renderFileExplorer();
  }
  function renderFileExplorer() {
    const container = byId("explorer-files");
    const count = byId("explorer-count");
    count.textContent = editedFiles.size ? `(${editedFiles.size})` : "";
    if (!editedFiles.size) {
      container.innerHTML = `<div class="explorer-empty">No edited files yet.</div>`;
      return;
    }
    container.innerHTML = "";
    const groups = new Map;
    for (const file of [...editedFiles.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const slash = file.path.lastIndexOf("/");
      const directory = slash > 0 ? file.path.slice(0, slash) : ".";
      const group = groups.get(directory) || [];
      group.push(file);
      groups.set(directory, group);
    }
    for (const [directory, files] of groups) {
      const heading = document.createElement("div");
      heading.className = "explorer-dir";
      heading.textContent = `⌄ ${directory}`;
      heading.title = directory;
      container.appendChild(heading);
      for (const file of files) {
        const button = document.createElement("button");
        button.className = "explorer-file";
        const name = file.path.slice(file.path.lastIndexOf("/") + 1);
        button.title = `${file.path}
Latest change: ${file.operation}`;
        button.innerHTML = `<span class="file-name">${escapeHtml(name)}</span><span class="file-status">M</span>`;
        button.onclick = () => {
          file.tool.open = true;
          file.tool.scrollIntoView({ behavior: "smooth", block: "center" });
        };
        container.appendChild(button);
      }
    }
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
    resultDiv.innerHTML = `<div class="section-label">result</div>${escapeHtml(boundedTail(stripAnsi(ev.text || ""), maxToolTextChars))}`;
    body.appendChild(resultDiv);
    const tools = container.querySelectorAll("details.tool");
    const isMostRecent = tools.length > 0 && tools[tools.length - 1] === details;
    details.open = isMostRecent && isShellTool(ev.name);
  }
  var ANSI_PATTERN = /\u001B\[[0-9;?]*[ -\/]*[@-~]|\u001B\][^\u0007]*\u0007/g;
  function stripAnsi(s) {
    return String(s ?? "").replace(ANSI_PATTERN, "");
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
  }
  function renderModelMarkdown(source) {
    const escaped = escapeHtml(stripAnsi(source).replace(/\*\*\*\*/g, `**
**`));
    return escaped.replace(/\*\*([^*\n]+)\*\*(?=[^\s*])/g, "<strong>$1</strong><br>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/\r?\n/g, "<br>");
  }
  function renderEvent(container, ev) {
    switch (ev.type) {
      case "text": {
        const bubble = textNodeOrBubble(container);
        const source = boundedTail((modelTextByBubble.get(bubble) || "") + ev.text, maxModelBubbleChars);
        modelTextByBubble.set(bubble, source);
        bubble.innerHTML = renderModelMarkdown(source);
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
      case "usage":
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
    if (!selected || !selected.trial)
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
        if (data.truncated && !container.querySelector(".live-window-notice")) {
          const notice = document.createElement("div");
          notice.className = "banner live-window-notice";
          notice.textContent = "Showing the latest 512 KiB. Full output remains on disk.";
          container.appendChild(notice);
        }
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
