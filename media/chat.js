// NEO sidebar webview. Draws what the extension host sends and posts the user's actions back.
// It never talks to NEO itself (NEO has no CORS/auth for browser origins) and never decides a
// phase, a gate or a check: all of that arrives in `state` messages from the host.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  window.neoPost = (message) => vscode.postMessage(message);   // for media/changes.js: the API can be acquired once
  const $ = (id) => document.getElementById(id);

  const view = {
    state: null,
    parts: new Map(),          // `${kind}:${part}` -> { node, body, raw }
    maxSeq: 0,                 // newest persisted event drawn; older copies are dropped
    gateSig: "",
    gateRefusal: null,         // { confirmable } after a refused approval, until the gate changes
    lastRole: "",              // "user" | "neo" | "other": who drew the last conversation item
    contextSig: "",            // the attachments and suggestion last drawn
    atPos: -1,                 // where an "@" that opened the file picker was typed
    startingSession: false,    // a new session was asked for and NEO has not answered yet
    bannerSig: "",             // what the banner / empty state last drew
    gatePending: false,        // an approve / reject was sent and NEO has not answered yet
  };

  // --- small helpers -----------------------------------------------------------------------

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function show(id, visible) {
    $(id).classList.toggle("hidden", !visible);
  }

  /**
   * A short message. An error can carry a hint (what to do) and technical detail: the detail stays
   * folded under "Show details", and a toast that has any stays until it is closed, so it can be read.
   */
  function toast(text, level, extra) {
    const opts = extra || {};
    const node = el("div", `toast ${level || "info"}`);
    node.appendChild(el("div", "toast-text", text));
    if (opts.hint) node.appendChild(el("div", "toast-hint", opts.hint));
    const sticky = Boolean(opts.detail || opts.settings);
    if (opts.settings) {
      const row = el("div", "toast-actions");
      row.appendChild(settingsButton("secondary small"));
      node.appendChild(row);
    }
    if (opts.detail) node.appendChild(detailsBlock(opts.detail));
    if (sticky) {
      node.classList.add("sticky");
      const close = el("button", "toast-close", "×");
      close.type = "button";
      close.title = "Dismiss";
      close.setAttribute("aria-label", "Dismiss");
      close.addEventListener("click", () => node.remove());
      node.prepend(close);
    } else {
      setTimeout(() => node.remove(), level === "error" ? 7000 : 3500);
    }
    $("toasts").appendChild(node);
  }

  /** Technical detail (HTTP status, NEO's response, the network cause), folded by default. */
  function detailsBlock(detail) {
    const box = el("details", "error-details");
    const summary = el("summary", null, "Show details");
    box.appendChild(summary);
    box.appendChild(el("pre", null, detail));
    box.addEventListener("toggle", () => (summary.textContent = box.open ? "Hide details" : "Show details"));
    return box;
  }

  /** Summary, hint and details in one place: an inline error (the forms, the gate card). */
  function setError(node, m) {
    node.innerHTML = "";
    if (!m) return;
    node.appendChild(el("div", null, m.message || m.summary || ""));
    if (m.hint) node.appendChild(el("div", "error-hint", m.hint));
    if (m.detail) node.appendChild(detailsBlock(m.detail));
  }

  function nearBottom() {
    const t = $("transcript");
    return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  }

  function scrollDown() {
    const t = $("transcript");
    t.scrollTop = t.scrollHeight;
  }

  function clip(value, limit) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text.length > limit ? `${text.slice(0, limit)}\n… (clipped)` : text;
  }

  // A deliberately small Markdown renderer: everything is escaped first, then only the tags made
  // here are added. Agent output and gate documents are untrusted text.
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function inline(s) {
    return escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  }

  function markdown(src) {
    const out = [];
    let para = [];
    let list = null;
    let code = null;
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.join("")}</${list.tag}>`);
      list = null;
    };
    for (const line of String(src || "").split("\n")) {
      if (/^\s*```/.test(line)) {
        if (code) {
          out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
          code = null;
        } else {
          flushPara();
          flushList();
          code = [];
        }
        continue;
      }
      if (code) {
        code.push(line);
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (heading) {
        flushPara();
        flushList();
        const level = Math.min(heading[1].length + 2, 6);   // keep headings small in a sidebar
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (bullet || numbered) {
        flushPara();
        const tag = bullet ? "ul" : "ol";
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        let item = (bullet || numbered)[1];
        let box = "";
        const tick = /^\[( |x|X)\]\s+(.*)$/.exec(item);
        if (tick) {
          box = tick[1] === " " ? "☐ " : "☑ ";
          item = tick[2];
        }
        list.items.push(`<li>${box}${inline(item)}</li>`);
      } else if (!line.trim()) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    if (code) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    flushPara();
    flushList();
    return out.join("");
  }

  function setMarkdown(node, src) {
    node.innerHTML = markdown(src);
  }

  function stageLabel(phase) {
    const stages = (view.state && view.state.stages) || [];
    const stage = stages.find((s) => s.phase === phase);
    return stage ? stage.label : phase;
  }

  // The short name the header shows, built from the phase id NEO reports ("plan-gate" ->
  // "PLAN GATE"), so a phase this extension has never heard of still reads sensibly.
  function phaseName(phase) {
    return String(phase || "").replace(/[-_]+/g, " ").trim().toUpperCase();
  }

  /** A small "NEO" label opens each NEO turn, so long replies are easy to tell from the user's. */
  function startNeoTurn(t) {
    if (view.lastRole !== "neo") t.appendChild(el("div", "turn-label", "NEO"));
    view.lastRole = "neo";
  }

  // --- attached context in a message -------------------------------------------------------

  // The extension host writes attachments after this line (src/context.ts); change both together.
  const CONTEXT_MARKER = "\n\n--- Attached from VS Code ---\n";

  /** A message's own words, and the files attached under the marker, if any. */
  function splitContext(text) {
    const src = String(text || "");
    const at = src.indexOf(CONTEXT_MARKER);
    if (at < 0) return { message: src, items: [] };
    const items = [];
    const lines = src.slice(at + CONTEXT_MARKER.length).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const head = /^File: (.+)$/.exec(lines[i]);
      const open = head && /^(`{3,})/.exec(lines[i + 1] || "");
      if (!open) continue;
      const body = [];
      let j = i + 2;
      for (; j < lines.length && lines[j] !== open[1]; j++) body.push(lines[j]);
      items.push({ title: head[1], body: body.join("\n") });
      i = j;
    }
    return { message: src.slice(0, at), items };
  }

  /** "src/app.py · lines 20–35" -> "app.py · lines 20–35" */
  function chipLabel(title) {
    const [file, ...rest] = String(title).split(" · ");
    return [file.split(/[\\/]/).pop(), ...rest].join(" · ");
  }

  function sentChips(labels, titles) {
    const row = el("div", "sent-context");
    labels.forEach((label, i) => {
      const chip = el("span", "ctx-chip static", label);
      chip.title = titles ? titles[i] : label;
      row.appendChild(chip);
    });
    return row;
  }

  /** The user's words as the message; attached files as chips, their content one click away. */
  function userContent(wrap, text) {
    const { message, items } = splitContext(text);
    const body = el("div", "md");
    setMarkdown(body, message);
    wrap.appendChild(body);
    if (!items.length) return;
    wrap.appendChild(sentChips(items.map((it) => chipLabel(it.title)), items.map((it) => it.title)));
    const more = el("details", "context-details");
    more.appendChild(el("summary", null, items.length === 1 ? "Show attached context" : `Show attached context (${items.length})`));
    items.forEach((it) => {
      more.appendChild(el("div", "context-title", it.title));
      more.appendChild(el("pre", null, it.body));
    });
    wrap.appendChild(more);
  }

  // --- transcript ---------------------------------------------------------------------------

  function resetTranscript() {
    $("transcript").innerHTML = "";
    view.parts.clear();
    view.maxSeq = 0;
    view.lastRole = "";
  }

  function render(ev, live) {
    if (typeof ev.seq === "number") {
      if (ev.seq <= view.maxSeq) return;
      view.maxSeq = ev.seq;
    }
    const t = $("transcript");
    const before = t.lastElementChild;
    drawEvent(ev, live, t);
    // The event a new row came from: media/sessions.js places session and "new" markers by it.
    const drawn = t.lastElementChild;
    if (typeof ev.seq === "number" && drawn && drawn !== before && !drawn.dataset.seq) drawn.dataset.seq = String(ev.seq);
  }

  function drawEvent(ev, live, t) {
    switch (ev.kind) {
      case "user": {
        if (live) t.querySelectorAll(".msg.user.optimistic").forEach((n) => n.remove());
        if (ev.note === "kickoff") {
          t.appendChild(kickoffBlock(ev.text));
          view.lastRole = "user";
          break;
        }
        const wrap = el("div", "msg user");
        if (ev.note) wrap.dataset.note = ev.note;      // NEO's own messages are drawn quieter (sessions.css)
        if (ev.note) wrap.appendChild(el("span", "note", ev.note));
        userContent(wrap, ev.text);
        t.appendChild(wrap);
        view.lastRole = "user";
        break;
      }
      case "text": {
        const key = `text:${ev.part}`;
        let entry = view.parts.get(key);
        if (!entry) {
          startNeoTurn(t);
          const node = el("div", "msg agent");
          const body = el("div", "md");
          node.appendChild(body);
          entry = { node, body, raw: "" };
          view.parts.set(key, entry);
          t.appendChild(node);
        }
        if (ev.replace && typeof ev.text === "string") entry.raw = ev.text;
        else entry.raw += ev.delta || "";
        setMarkdown(entry.body, entry.raw);
        break;
      }
      case "tool": {
        const key = `tool:${ev.part}`;
        let entry = view.parts.get(key);
        if (!entry) {
          startNeoTurn(t);
          const node = el("details", "msg tool");
          node.dataset.part = String(ev.part);           // media/changes.js links its file
          const summary = el("summary");
          const status = el("span", "tool-status");
          const title = el("span", "tool-title");
          summary.append(status, el("span", "tool-name", ev.tool || "tool"), title);
          const body = el("pre", "tool-body");
          node.append(summary, body);
          entry = { node, status, title, body };
          view.parts.set(key, entry);
          t.appendChild(node);
        }
        // A coloured dot, not a word: a tool row is background detail. A failure keeps its word.
        entry.status.textContent = ev.status === "error" ? "failed" : "";
        entry.status.title = ev.status || "";
        entry.status.className = `tool-status ${ev.status || ""}`;
        entry.title.textContent = ev.title || "";
        const detail = [];
        if (ev.input !== undefined && ev.input !== null) detail.push(`input: ${clip(ev.input, 1500)}`);
        if (ev.output) detail.push(`output: ${clip(ev.output, 2500)}`);
        if (ev.error) detail.push(`error: ${clip(ev.error, 1500)}`);
        entry.body.textContent = detail.join("\n\n");
        break;
      }
      case "question":
        renderQuestion(ev, t);
        view.lastRole = "other";
        break;
      case "notice":
        // Most notices are NEO narrating its own checks; the ones that stop for the user stand out.
        t.appendChild(el("div", `msg system${noticeNeedsUser(ev) ? " attention" : ""}`, noticeText(ev)));
        break;
      case "phase":
        if (ev.phase && ev.phase !== "done") t.appendChild(el("div", "divider", stageLabel(ev.phase)));
        if (ev.phase === "done") t.appendChild(el("div", "divider done", "Done"));
        view.lastRole = "other";
        break;
      case "gate": {
        const wrap = el("div", "msg gate-mark");
        wrap.appendChild(el("span", "note", "gate reached"));
        wrap.appendChild(el("strong", null, ev.title || "Gate"));
        if (ev.artifact_path) wrap.appendChild(el("code", "path", ev.artifact_path));
        if (ev.artifact) {
          const doc = el("details", "gate-doc");
          doc.appendChild(el("summary", null, `${ev.artifact_path || "document"} · ${String(ev.artifact).split("\n").length} lines`));
          const body = el("div", "md");
          setMarkdown(body, ev.artifact);
          doc.appendChild(body);
          wrap.appendChild(doc);
        }
        t.appendChild(wrap);
        view.lastRole = "other";
        break;
      }
      case "error": {
        const key = `error:${ev.part || Math.random()}`;
        const existing = view.parts.get(key);
        if (existing && !ev.replace) break;
        const wrap = el("div", "msg error");
        const label = [ev.name, ev.statusCode && `HTTP ${ev.statusCode}`].filter(Boolean).join(" · ");
        if (label) wrap.appendChild(el("span", "note", label));
        wrap.appendChild(el("pre", null, ev.message || "error"));
        if (existing) existing.node.replaceWith(wrap);
        else t.appendChild(wrap);
        view.parts.set(key, { node: wrap });
        view.lastRole = "other";
        break;
      }
      default:
        break;                                         // status / idle only move state
    }
  }

  /**
   * The prompt NEO opens a project with: the user's request wrapped in NEO's own instructions.
   * The request is shown; the full prompt stays one click away. The request is the project's
   * stored idea, used only when the prompt really contains it — otherwise only the summary line
   * shows, and the whole text is still under "Show details". The idea arrives with the state,
   * which can come after the event, so a block fills itself in whenever it does.
   */
  const kickoffText = new WeakMap();

  function fillKickoff(wrap) {
    const raw = kickoffText.get(wrap) || "";
    const idea = ((view.state && view.state.project && view.state.project.idea) || "").trim();
    if (!idea || !raw.includes(idea)) return;
    wrap.classList.add("has-idea");
    wrap.querySelector(".note").textContent = "Project started with your requirements";
    const body = el("div");
    userContent(body, idea);
    wrap.insertBefore(body, wrap.querySelector(".kickoff-details"));
  }

  function fillKickoffs() {
    document.querySelectorAll(".msg.kickoff:not(.has-idea)").forEach(fillKickoff);
  }

  function kickoffBlock(text) {
    const raw = String(text || "");
    const wrap = el("div", "msg user kickoff");
    kickoffText.set(wrap, raw);
    wrap.appendChild(el("span", "note", "Project started"));
    const more = el("details", "kickoff-details");
    more.appendChild(el("summary", null, "Show details"));
    const full = el("div", "md");
    setMarkdown(full, raw);
    more.appendChild(full);
    more.addEventListener("toggle", () => {
      more.querySelector("summary").textContent = more.open ? "Hide details" : "Show details";
    });
    wrap.appendChild(more);
    fillKickoff(wrap);
    return wrap;
  }

  function renderQuestion(ev, t) {
    const wrap = el("div", "msg question");
    wrap.dataset.request = ev.request || "";
    wrap.appendChild(el("span", "note", "NEO asks"));
    if (ev.context) wrap.appendChild(el("pre", "q-context", ev.context));
    const questions = ev.questions || [];
    const many = questions.length > 1;
    questions.forEach((q, qi) => {
      const body = el("div", "md");
      setMarkdown(body, q.question);
      wrap.appendChild(body);
      const replies = (q.options && q.options.length ? q.options : q.quick) || [];
      if (!replies.length) return;
      const row = el("div", `options ${many ? "choice" : ""}`);
      row.dataset.question = String(qi);
      replies.slice(0, 8).forEach((label) => {
        const button = el("button", "option", label);
        button.type = "button";
        button.dataset.reply = label;
        button.addEventListener("click", () => onOption(wrap, row, button, many));
        row.appendChild(button);
      });
      wrap.appendChild(row);
    });
    if (many) {
      const send = el("button", "primary small answer-all", "Send answers");
      send.type = "button";
      send.disabled = true;
      send.addEventListener("click", () => {
        const answers = [...wrap.querySelectorAll(".options.choice")].map(
          (r) => r.querySelector("button.option.chosen").dataset.reply,
        );
        answer(wrap, { request: wrap.dataset.request || undefined, answers }, answers.join(" · "));
      });
      wrap.appendChild(send);
    }
    wrap.appendChild(el("div", "hint", "pick an option, or type your answer below"));
    t.appendChild(wrap);
  }

  function onOption(wrap, row, button, many) {
    if (button.disabled) return;
    row.querySelectorAll("button.option").forEach((b) => b.classList.toggle("chosen", b === button));
    if (many) {
      const rows = [...wrap.querySelectorAll(".options.choice")];
      wrap.querySelector(".answer-all").disabled = !rows.every((r) => r.querySelector(".chosen"));
      return;
    }
    const text = button.dataset.reply;
    answer(wrap, { request: wrap.dataset.request || undefined, text }, text);
  }

  function answer(wrap, payload, echo) {
    wrap.querySelectorAll("button").forEach((b) => (b.disabled = true));
    wrap.classList.add("answered");
    echoUser(echo);
    vscode.postMessage({ type: "answer", ...payload });
  }

  /** Only the question NEO says is open can be answered; every other one is history. */
  function syncQuestions() {
    const s = view.state || {};
    const blocks = [...document.querySelectorAll(".msg.question")];
    const open = s.awaiting ? blocks.filter((b) => !b.classList.contains("answered")) : [];
    const live = s.pendingRequest
      ? open.filter((b) => b.dataset.request === s.pendingRequest).pop()
      : open.pop();
    blocks.forEach((b) => {
      const active = b === live;
      b.classList.toggle("open", active);
      b.querySelectorAll("button.option").forEach((btn) => (btn.disabled = !active || !s.ready));
      const all = b.querySelector(".answer-all");
      // "Send answers" needs every question answered, as before, and a confirmed connection.
      if (all) all.disabled = !active || !s.ready || ![...b.querySelectorAll(".options.choice")].every((r) => r.querySelector(".chosen"));
    });
  }

  function noticeNeedsUser(ev) {
    return Boolean(ev.stalled || ev.runaway || ev.timeout || ev.held || ev.repair_stuck
      || (ev.incomplete && ev.exhausted));
  }

  function noticeText(ev) {
    if (ev.stalled) return `${ev.stalled} — send guidance to continue`;
    if (ev.runaway) return `runaway output — turn aborted`;
    if (ev.timeout) return `no activity for ${ev.timeout}s — turn aborted`;
    if (ev.auto_approved) return `${ev.auto_approved} approved automatically — every check passed`;
    if (ev.missing_signal) return `completion claimed with no signal — asked the agent for “${ev.missing_signal}”`;
    if (ev.invented) return `“${ev.invented}” is not a signal — asked for “${ev.expected}”`;
    if (ev.incomplete) {
      return ev.exhausted
        ? `execution incomplete — ${ev.count} plan step(s) unticked; waiting for you`
        : `not finished — ${ev.count} plan step(s) unticked (${ev.attempt}/${ev.limit}), continuing`;
    }
    if (ev.resumed) return `a turn in ${ev.resumed} was cut off by a restart — resuming`;
    if (ev.held) return `${ev.held} held for you: ${ev.failed}`;
    if (ev.repair_stuck) return `automatic repair stopped on ${ev.repair_stuck} — the gate is open for you`;
    if (ev.repair) return `refused “${ev.repair}” — ${ev.failed} still failing (${ev.attempt}/${ev.limit})`;
    if (ev.unearned) return `refused “${ev.unearned}”: the turn did no work`;
    if (ev.ignored) return `ignored an out-of-order signal (${ev.ignored})`;
    return `notice in ${ev.phase || "this phase"}`;
  }

  function echoUser(text, labels) {
    const wrap = el("div", "msg user optimistic");
    const body = el("div", "md");
    setMarkdown(body, text);
    wrap.appendChild(body);
    if (labels && labels.length) wrap.appendChild(sentChips(labels));
    $("transcript").appendChild(wrap);
    view.lastRole = "user";
    scrollDown();
  }

  // --- state: header, banners, composer, gate card -------------------------------------------

  function applyState(s) {
    view.state = s;
    const connected = s.connection === "connected";

    // connection line: a short word in the header, the full story in the tooltip
    const conn = $("conn");
    const reconnecting = (connected && s.stream === "reconnecting") || s.connection === "reconnecting";
    const runtimeDown = connected && s.runtimeReachable === false;
    conn.className = `conn ${s.connection}${reconnecting || runtimeDown ? " degraded" : ""}`;
    $("conn-text").textContent = s.connection === "connecting" ? "Connecting…"
      : s.connection === "unreachable" ? "Offline"
      : reconnecting ? "Reconnecting…"
      : runtimeDown ? "Agent runtime unreachable" : "Connected";
    const detail = [s.connection === "connecting" ? `Connecting to ${s.serverUrl}`
      : connected ? `Connected to ${s.serverUrl}`
      : s.connection === "reconnecting" ? `Reconnecting to ${s.serverUrl}` : `NEO is offline: ${s.serverUrl}`];
    if (connected && s.stream === "reconnecting") detail.push("live stream reconnecting");
    if (runtimeDown) detail.push("agent runtime unreachable");
    if (!connected && s.offline && s.offline.hint) detail.push(s.offline.hint);
    conn.title = detail.join(" · ");
    renderHeaderActions(s);

    // Project name only for a real NEO project: an open folder that is not one yet stays unnamed.
    const inProject = s.mode === "project";
    $("project-name").textContent = s.project ? s.project.name : "";
    $("project-name").title = s.project ? s.project.path : "";
    show("title-sep", Boolean(s.project));
    // The phase itself is shown by the rail and by the chip under the input, not in the header.
    const phase = s.phase && inProject ? s.phase : "";
    const kind = phase.endsWith("-gate") ? "gate" : phase === "done" ? "done" : "";
    // Actively running a turn — not waiting on an answer or an approval.
    const working = connected && inProject && s.busy && !s.awaiting && !s.atGate;
    // The host's rail (src/plan.ts railStages): a gate waiting for a decision is not yet current.
    renderRail(inProject ? s.rail || s.stages : []);

    // Current plan task, plan progress, current action, and the single line for a stall, a stop
    // or a reconnect. All of it is computed by the host (src/progress.ts) and drawn into #live by
    // media/progress.js, so nothing here has to work out a count or a state.
    const live = s.live || null;
    if (window.NeoProgress) window.NeoProgress.render(live);

    renderBanner(s);
    show("transcript", inProject);
    show("composer", inProject);
    if (!inProject) show("gate", false);
    $("transcript").dataset.empty = s.phase === "setup"
      ? "Describe what you want built below. NEO takes it from there, one gate at a time."
      : "No messages yet.";

    // composer: Send stays off while the agent is working, unless it is waiting on an answer
    // A completed session takes no more work: what is sent next starts a new session (the host's
    // startSession, NEO's POST /sessions). It is never a message into the finished one.
    const finished = inProject && s.phase === "done";
    // `ready` is the host's "confirmed Connected" (the header's word): never while connecting,
    // reconnecting or offline. The box stays editable and the chips stay; only the action waits.
    const ready = Boolean(s.ready);
    const canSend = ready && inProject && (!s.busy || s.awaiting) && !view.startingSession;
    $("send").disabled = !canSend;
    $("composer").classList.toggle("disabled", !canSend);
    $("composer").classList.toggle("working", working);
    $("composer").classList.toggle("finished", finished);
    const action = finished ? "Start a new session with this request" : "Send";
    $("send").title = ready ? `${action} (${sendKey})` : `${action}: ${notReadyReason(s)}`;
    $("send").setAttribute("aria-label", finished ? "Start a new session" : "Send");
    $("send-hint").textContent = finished ? `${sendKey} · new session` : `${sendKey} to send`;
    $("message").placeholder = !inProject ? "" : s.phase === "setup"
      ? "Describe what you want built — this starts the project"
      : finished ? "This session is complete. Describe the next piece of work — it starts a new session."
      : s.awaiting ? "Answer NEO…" : working ? "NEO is working — you can type, Send unlocks when it stops"
      : s.atGate ? "Message NEO, or use the gate above" : "Message NEO…";
    renderStop(live, working, s);
    renderComposerStatus(s, connected, working, phase, kind, live);
    renderContext(s);

    if (inProject) renderGate(s);
    syncQuestions();
    fillKickoffs();
  }

  /**
   * The context the next message will carry, each removable, plus a dashed one-click offer of the
   * file or selection the user is in. Redrawn only when it changes: state arrives many times a
   * second while NEO streams, and rebuilding the buttons would swallow clicks.
   */
  function renderContext(s) {
    const attachments = s.attachments || [];
    const sig = JSON.stringify([attachments, s.suggestion]);
    if (sig === view.contextSig) return;
    view.contextSig = sig;
    const row = $("context-row");
    row.innerHTML = "";
    attachments.forEach((a) => {
      const chip = el("span", `ctx-chip ${a.kind}`);
      chip.title = a.detail;
      chip.appendChild(el("span", "ctx-label", a.label));
      const remove = el("button", "ctx-remove", "×");
      remove.type = "button";
      remove.title = `Remove ${a.label}`;
      remove.setAttribute("aria-label", `Remove ${a.label}`);
      remove.addEventListener("click", () => vscode.postMessage({ type: "removeContext", id: a.id }));
      chip.appendChild(remove);
      row.appendChild(chip);
    });
    if (s.suggestion) {
      const offer = el("button", "ctx-chip suggested", `+ ${s.suggestion.label}`);
      offer.type = "button";
      offer.title = `Attach ${s.suggestion.kind === "selection" ? "the selected lines" : "this file"} to your message`;
      offer.addEventListener("click", () => vscode.postMessage({ type: "addContext", source: "suggested" }));
      row.appendChild(offer);
    }
    show("context-row", row.childElementCount > 0);
  }

  /**
   * The line under the input: the phase, and one word for what NEO is doing in it. The words come
   * from the host so that this line and the live panel above can never contradict each other.
   */
  function renderComposerStatus(s, connected, working, phase, kind, live) {
    const box = $("composer-status");
    box.innerHTML = "";
    const chip = el("span", `chip ${kind}`, phaseName(phase));
    // At a gate, the gate's own title ("Code review"), not the label of what approval leads to.
    chip.title = !phase ? "" : s.atGate && s.gate && s.gate.title ? s.gate.title : stageLabel(phase);
    if (phase) box.appendChild(chip);
    const activity = live ? live.activity : connected ? "idle" : "offline";
    const text = live ? live.label : connected ? "" : "not connected";
    if (!text) return;
    const cls = { working: "working", stopping: "working", awaiting: "attention", gate: "attention",
                  attention: "attention", offline: "", stopped: "", done: "done", idle: "" }[activity] || "";
    const line = el("span", `status-text ${cls}`);
    if (working || activity === "stopping") line.appendChild(el("span", "spinner"));
    line.appendChild(document.createTextNode(text));
    // The whole story, including what Stop would do, is one hover away.
    line.title = live ? live.detail : "";
    box.appendChild(line);
  }

  /**
   * Stop. Offered only while NEO is actually running a turn — never while it waits for an answer,
   * waits at a gate, is idle, or is done — and it says what it does before and after the click.
   */
  function renderStop(live, working, s) {
    const button = $("abort");
    const stopping = Boolean(live && live.activity === "stopping");
    show("abort", Boolean(working || stopping));
    $("abort-label").textContent = stopping ? "Stopping…" : "Stop";
    button.disabled = stopping || !s.ready;
    button.classList.toggle("stopping", stopping);
    button.title = stopping
      ? "Stop was sent. NEO is ending the running turn; this takes a moment."
      : !s.ready ? `Stop: ${notReadyReason(s)}`
      : (live && live.stopHint) || "Stop the running turn";
  }

  /** Why an action that changes NEO's state is unavailable right now. */
  function notReadyReason(s) {
    return s.connection === "connecting" ? "unavailable while connecting to NEO"
      : s.connection === "unreachable" ? "unavailable while NEO is offline"
      : "unavailable while reconnecting to NEO";
  }

  function renderRail(stages) {
    const rail = $("rail");
    rail.innerHTML = "";
    show("rail", Boolean(stages && stages.length));
    (stages || []).forEach((stage, i) => {
      if (i) rail.appendChild(el("span", "sep", "›"));
      const chip = el("span", `stage ${stage.state} ${stage.kind}`, stage.label);
      chip.title = stage.state === "waiting" ? `${stage.phase} - waiting for your decision` : stage.phase;
      rail.appendChild(chip);
    });
  }

  function actionButton(label, cls, onClick) {
    const button = el("button", cls, label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  // Retry repeats reads only (the host's retry): with a project open it stays, with its draft and context.
  function retryButton(s, cls) {
    const button = actionButton(s && s.retrying ? "Retrying…" : "Retry", cls || "primary", () => vscode.postMessage({ type: "retry" }));
    button.disabled = Boolean(s && s.retrying);
    return button;
  }
  function settingsButton(cls) {
    const button = actionButton("Open NEO Settings", cls || "secondary", () => vscode.postMessage({ type: "openSettings" }));
    button.title = "Open VS Code Settings for NEO (the server URL)";
    return button;
  }
  const projectsButton = (cls) => actionButton("Projects", cls, () => vscode.postMessage({ type: "switchProject" }));
  const webButton = () => actionButton("Open Web UI", "secondary", () => vscode.postMessage({ type: "openBrowser" }));

  /**
   * The header's actions stay where they are; the ones that need NEO are disabled while it cannot
   * answer, and say why on hover.
   */
  function renderHeaderActions(s) {
    const online = s.connection === "connected";
    const why = s.connection === "connecting"
      ? "Connecting to NEO…"
      : `NEO is offline (${s.serverUrl}). Start the NEO server, then Retry.`;
    const set = (id, enabled, title) => {
      const button = $(id);
      button.disabled = !enabled;
      button.title = title;
    };
    set("act-projects", online, online ? "Projects: switch to another NEO project" : `Projects unavailable: ${why}`);
    set("act-new", online && Boolean(s.folder),
      !online ? `New Project unavailable: ${why}`
        : !s.folder ? "New Project unavailable: open a folder first. A new project is created in the open folder."
        : "New Project in the open folder");
    set("act-web", online, online ? "Open the NEO Web UI"
      : `Web UI unavailable: it is served by the NEO server. ${why}`);
  }

  /** The brand mark at empty-state size. */
  function bigMark() {
    const mark = document.querySelector(".title .brand-mark").cloneNode(true);
    mark.setAttribute("width", "40");
    mark.setAttribute("height", "40");
    return mark;
  }

  /** One line of the first-run status block: a dot, then what it says. */
  function statusLine(tone, ...parts) {
    const line = el("div", `empty-status-line ${tone}`);
    line.appendChild(el("span", "dot"));
    const text = el("span", "empty-status-text");
    parts.forEach((p) => text.append(typeof p === "string" ? document.createTextNode(p) : p));
    line.appendChild(text);
    return line;
  }

  function offlineHelp(s, box) {
    const off = s.offline || {};
    if (off.config && off.hint) box.appendChild(el("p", "empty-hint", off.hint));
    if (off.detail) box.appendChild(detailsBlock(off.detail));
  }

  /**
   * Everything that is not a conversation. Inside a project only a lost connection is shown, as a
   * slim banner above the transcript; without one, the panel is a centred empty state that says
   * what NEO is, whether it is connected, and whether this folder is a NEO project.
   */
  function renderBanner(s) {
    const banner = $("banner");
    const unreachable = s.connection === "unreachable";
    const visible = s.mode !== "project" || unreachable || s.connection === "reconnecting";
    // Redrawn only when what it says changes: state arrives often, and a rebuild would close an
    // open "Show details" and swallow a click on Retry.
    const sig = JSON.stringify([s.mode, s.connection, s.serverUrl, s.offline, s.problem, s.retrying, s.folder, s.folderName]);
    if (sig !== view.bannerSig) {
      view.bannerSig = sig;
      banner.innerHTML = "";
      drawBanner(s, banner, unreachable);
    }
    show("banner", visible && $("new-project").classList.contains("hidden"));
  }

  function drawBanner(s, banner, unreachable) {
    if (s.mode === "project") {
      if (s.connection === "reconnecting") {
        banner.className = "banner warn";
        const head = el("div", "banner-head");
        head.append(el("span", "spinner"), el("strong", null, "Reconnecting to NEO…"));
        banner.appendChild(head);
        banner.appendChild(el("p", "muted", "NEO stopped answering. Your project, draft and attached files are kept while the sidebar keeps trying."));
      } else if (unreachable) {
        banner.className = "banner error";
        banner.appendChild(el("strong", null, "NEO is offline"));
        const lead = el("p");
        lead.append(document.createTextNode("Can't reach the NEO server at "), el("code", "path", s.serverUrl),
          document.createTextNode(". Your project, draft and attached files are kept; the sidebar reconnects on its own when NEO is back."));
        banner.appendChild(lead);
        const buttons = el("div", "buttons");
        buttons.append(retryButton(s), settingsButton());
        banner.appendChild(buttons);
        offlineHelp(s, banner);
      }
    } else if (s.mode === "loading" || s.connection === "connecting") {
      banner.className = "empty";
      const line = el("div", "empty-loading muted");
      line.append(el("span", "spinner"), document.createTextNode(
        s.connection === "connecting" ? `Connecting to NEO at ${s.serverUrl}…` : "Loading project…"));
      banner.appendChild(line);
    } else {
      banner.className = "empty";
      banner.append(bigMark());
      const buttons = el("div", "empty-actions");
      if (unreachable) {
        banner.appendChild(el("div", "empty-title", "NEO is offline"));
        const lead = el("p", "empty-lead");
        lead.append(document.createTextNode("Can't reach the NEO server at "), el("code", "path", s.serverUrl), document.createTextNode("."));
        banner.appendChild(lead);
        banner.appendChild(el("p", "muted", "NEO runs as a separate server: start it (scripts\\start.ps1 on Windows, scripts/start.sh on Linux), then Retry. If it runs at another address, change the server URL in the NEO settings."));
        buttons.append(retryButton(s), settingsButton());
        banner.appendChild(buttons);
        offlineHelp(s, banner);
        banner.appendChild(el("p", "muted small", "The sidebar checks again every 10 seconds."));
      } else {
        banner.appendChild(el("div", "empty-title", "NEO"));
        banner.appendChild(el("p", "empty-lead",
          "NEO builds software from your request through a guided pipeline: design, plan, build and review, stopping at gates for your approval."));
        const status = el("div", "empty-status");
        status.appendChild(statusLine("ok", "Connected to ", el("code", "path", s.serverUrl)));
        if (s.mode === "noFolder") {
          status.appendChild(statusLine("muted", "No folder open. Open one to create a NEO project there."));
          buttons.append(
            actionButton("Open Folder", "primary", () => vscode.postMessage({ type: "pickFolder" })),
            projectsButton("secondary"),
            webButton(),
          );
        } else {
          const name = el("code", "path", s.folderName || s.folder || "");
          name.title = s.folder || "";
          status.appendChild(statusLine("warn", "Folder ", name, " is not a NEO project yet."));
          buttons.append(
            actionButton("New Project", "primary", () => openNewProject(s.folderName || "")),
            projectsButton("secondary"),
            webButton(),
          );
        }
        banner.appendChild(status);
        if (s.problem) {
          // A read that failed with nothing on screen to keep: what failed, Retry, and the details.
          const box = el("div", "empty-problem");
          setError(box, s.problem);
          box.appendChild(retryButton(s, "secondary small"));
          banner.appendChild(box);
        }
        banner.appendChild(buttons);
      }
      banner.appendChild(el("div", "empty-by", "Powered by CodeValue"));
    }
  }

  function renderGate(s) {
    const gate = s.atGate ? s.gate : null;
    if (!gate) {
      if (!$("gate").classList.contains("hidden")) resetGateCard();
      show("gate", false);
      return;
    }
    const checks = gate.checks || [];
    const sig = JSON.stringify([gate.phase, gate.title, gate.artifact_path, (gate.artifact || "").length,
                                checks, Boolean(gate.checks_pending)]);
    show("gate", true);
    syncGateButtons();
    if (sig === view.gateSig) return;                 // unchanged: keep the user's text and scroll
    const phaseChanged = !view.gateSig || JSON.parse(view.gateSig)[0] !== gate.phase;
    view.gateSig = sig;
    if (phaseChanged) {
      view.gateRefusal = null;
      show("gate-refusal", false);
      show("gate-anyway", false);
      $("gate-error").textContent = "";
      $("gate-doc").open = true;
    }

    $("gate-title").textContent = gate.title || "Gate";
    $("gate-phase").textContent = gate.phase || s.phase || "";
    $("gate-path").textContent = gate.artifact_path || "(no document)";
    const doc = gate.artifact || "";
    $("gate-doc-summary").textContent = gate.artifact_missing || !doc
      ? `${gate.artifact_path || "document"} — missing`
      : `${gate.artifact_path || "document"} · ${doc.split("\n").length} lines`;
    setMarkdown($("gate-doc-body"), doc);

    const list = $("gate-checks");
    list.innerHTML = "";
    if (gate.checks_pending) {
      list.appendChild(el("li", "check pending", "checks not computed yet — NEO computes them when the gate opens"));
    } else if (!checks.length) {
      list.appendChild(el("li", "check muted", "no checks for this gate"));
    }
    checks.forEach((c) => {
      const state = c.advisory ? "advisory" : c.ok ? "pass" : c.conclusive === false ? "unknown" : "fail";
      const mark = { pass: "✓", fail: "✗", unknown: "?", advisory: "•" }[state];
      const li = el("li", `check ${state}`);
      li.appendChild(el("span", "mark", mark));
      li.appendChild(el("span", "name", c.name));
      if (c.detail) {
        const d = el("div", "detail", c.detail);
        li.appendChild(d);
      }
      list.appendChild(li);
    });
    const failing = checks.filter((c) => !c.advisory && !c.ok).length;
    $("gate-approve").dataset.baseTitle = failing ? `${failing} check(s) not passing — NEO will refuse a plain approval` : "";
    syncGateButtons();
  }

  function resetGateCard() {
    view.gateSig = "";
    view.gateRefusal = null;
    $("gate-text").value = "";
    $("gate-error").textContent = "";
    show("gate-refusal", false);
    show("gate-anyway", false);
    gateBusy(false);
  }

  function gateBusy(busy) {
    view.gatePending = busy;
    syncGateButtons();
  }

  /** The gate's buttons: off while a decision is on its way, and while NEO is not confirmed reachable. */
  function syncGateButtons() {
    const s = view.state || {};
    const off = view.gatePending || !s.ready;
    ["gate-approve", "gate-reject", "gate-anyway"].forEach((id) => ($(id).disabled = off));
    const reason = !view.gatePending && !s.ready ? notReadyReason(s) : "";
    ["gate-approve", "gate-reject", "gate-anyway"].forEach((id) => {
      const button = $(id);
      button.title = reason ? `${button.textContent}: ${reason}` : button.dataset.baseTitle || "";
    });
  }

  $("gate-approve").addEventListener("click", () => {
    $("gate-error").textContent = "";
    gateBusy(true);
    vscode.postMessage({ type: "approve" });
  });

  $("gate-reject").addEventListener("click", () => {
    const feedback = $("gate-text").value.trim();
    if (!feedback) {
      $("gate-error").textContent = "Say what needs to change, then press Request Changes.";
      $("gate-text").focus();
      return;
    }
    $("gate-error").textContent = "";
    gateBusy(true);
    vscode.postMessage({ type: "reject", feedback });
  });

  // Approving over failing checks is a separate, explicit act, offered only after NEO refused a
  // plain approval and said the refusal can be confirmed — and only with a reason.
  $("gate-anyway").addEventListener("click", () => {
    if (!view.gateRefusal || !view.gateRefusal.confirmable) return;
    const reason = $("gate-text").value.trim();
    if (!reason) {
      $("gate-error").textContent = "Write why these failures are acceptable, then press Approve anyway.";
      $("gate-text").focus();
      return;
    }
    $("gate-error").textContent = "";
    gateBusy(true);
    vscode.postMessage({ type: "approve", reason });
  });

  function onGateRefused(m) {
    gateBusy(false);
    view.gateRefusal = { confirmable: Boolean(m.confirmable) };
    const box = $("gate-refusal");
    box.innerHTML = "";
    box.appendChild(el("strong", null, "NEO refused the approval"));
    box.appendChild(el("p", null, m.message || ""));
    if (m.detail) box.appendChild(detailsBlock(m.detail));
    if (m.failed && m.failed.length) {
      const ul = el("ul", "checks");
      m.failed.forEach((c) => {
        const li = el("li", "check fail");
        li.appendChild(el("span", "mark", "✗"));
        li.appendChild(el("span", "name", c.name || "check"));
        if (c.detail) li.appendChild(el("div", "detail", c.detail));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    if (m.confirmable) {
      box.appendChild(el("p", "muted", "You can request changes, or approve anyway — that records your reason with the overrule."));
      $("gate-text").placeholder = "What should change — or, to approve anyway, why these failures are acceptable";
    }
    show("gate-refusal", true);
    show("gate-anyway", Boolean(m.confirmable));
  }

  // --- composer ----------------------------------------------------------------------------

  // The input grows with what is typed, up to a cap, then scrolls.
  function fitInput() {
    const box = $("message");
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 220)}px`;
  }

  const sendKey = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘+Enter" : "Ctrl+Enter";
  $("send-hint").textContent = `${sendKey} to send`;
  $("send").title = `Send (${sendKey})`;

  // The host keeps each project's unsent text (src/chatViewProvider.ts switchComposer): it is told
  // whenever the box changes, so a switch of project can put this one away and bring the other back.
  function syncDraft() {
    vscode.postMessage({ type: "draft", text: $("message").value });
  }

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("message").value.trim();
    if (!text || $("send").disabled) return;
    if ($("composer").classList.contains("finished")) {
      // New work: the text stays in the box until NEO has started the session (or the user cancels
      // the choice of pipeline), so nothing is lost and nothing is echoed into the finished session.
      view.startingSession = true;
      $("send").disabled = true;
      vscode.postMessage({ type: "startSession", text });
      return;
    }
    $("message").value = "";
    fitInput();
    syncDraft();
    echoUser(text, ((view.state && view.state.attachments) || []).map((a) => a.label));
    vscode.postMessage({ type: "send", text });
  });

  $("add-context").addEventListener("click", () => vscode.postMessage({ type: "addContext", source: "menu" }));

  // "@" typed at the start or after a space opens "Choose file"; picking one replaces the "@" with
  // a chip. Cancelling leaves the "@" as typed, so an e-mail address or a decorator is unaffected.
  $("message").addEventListener("input", (e) => {
    fitInput();
    syncDraft();
    if (e.inputType !== "insertText" || e.data !== "@") return;
    const box = $("message");
    const at = box.selectionStart - 1;
    if (at > 0 && !/\s/.test(box.value.charAt(at - 1))) return;
    view.atPos = at;
    vscode.postMessage({ type: "addContext", source: "at" });
  });

  function atResolved() {
    const box = $("message");
    const at = view.atPos;
    view.atPos = -1;
    if (at < 0 || box.value.charAt(at) !== "@") return;
    box.value = box.value.slice(0, at) + box.value.slice(at + 1);
    box.focus();
    box.setSelectionRange(at, at);
    fitInput();
    syncDraft();
  }
  $("message").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });

  $("abort").addEventListener("click", () => vscode.postMessage({ type: "abort" }));

  // --- top-level actions ---------------------------------------------------------------------

  $("act-new").addEventListener("click", () => vscode.postMessage({ type: "newProject" }));
  $("act-web").addEventListener("click", () => vscode.postMessage({ type: "openBrowser" }));
  $("act-projects").addEventListener("click", () => vscode.postMessage({ type: "switchProject" }));

  // --- new project form ---------------------------------------------------------------------

  function openNewProject(name, hasProject) {
    if (hasProject) {
      // New work on this project is a new session, not a new project.
      const done = view.state && view.state.phase === "done";
      toast(done
        ? "This folder is already a NEO project. To start new work on it, type the next request in the message box: it starts a new session."
        : "This folder is already a NEO project. New work can start as a new session once its current session is complete.", "info");
      return;
    }
    $("np-name").value = name || "";
    $("np-folder").textContent = view.state && view.state.folder
      ? `Created in the open folder: ${view.state.folder}`
      : "Open an empty folder first.";
    $("np-error").textContent = "";
    show("new-project", true);
    show("banner", false);
    $("np-idea").focus();
  }

  function closeNewProject() {
    show("new-project", false);
    if (view.state) renderBanner(view.state);
  }

  $("np-cancel").addEventListener("click", closeNewProject);
  $("np-create").addEventListener("click", () => {
    const name = $("np-name").value.trim();
    const idea = $("np-idea").value.trim();
    if (!name) return void ($("np-error").textContent = "Give the project a name.");
    if (!idea) return void ($("np-error").textContent = "Describe what you want built.");
    $("np-error").textContent = "";
    $("np-create").disabled = true;
    $("np-create").textContent = "Creating…";
    vscode.postMessage({ type: "createProject", name, idea, interaction: $("np-interaction").value });
  });

  function newProjectDone() {
    $("np-create").disabled = false;
    $("np-create").textContent = "Create and start";
  }

  // --- messages from the host ---------------------------------------------------------------

  window.addEventListener("message", (e) => {
    const m = e.data || {};
    switch (m.type) {
      case "state":
        applyState(m.state);
        break;
      case "history": {
        resetTranscript();
        (m.events || []).forEach((ev) => render(ev, false));
        syncQuestions();
        scrollDown();
        break;
      }
      case "events": {
        const stick = nearBottom();
        (m.events || []).forEach((ev) => render(ev, true));
        syncQuestions();
        if (stick) scrollDown();
        break;
      }
      case "sendFailed":
        $("transcript").querySelectorAll(".msg.user.optimistic").forEach((n) => n.remove());
        if (!$("message").value) $("message").value = m.text || "";   // do not lose what was typed
        fitInput();
        syncDraft();
        toast(m.message, "error", m);
        break;
      case "answerFailed":
        $("transcript").querySelectorAll(".msg.user.optimistic").forEach((n) => n.remove());
        document.querySelectorAll(".msg.question.answered").forEach((b) => b.classList.remove("answered"));
        syncQuestions();
        toast(m.message, "error", m);
        break;
      case "gateRefused":
        onGateRefused(m);
        break;
      case "gateFailed":
        // NEO did not answer (or failed): not a refusal. The card stays as it was, ready to try again.
        gateBusy(false);
        setError($("gate-error"), m);
        break;
      case "gateDone":
        resetGateCard();
        show("gate", false);
        break;
      case "showNewProject":
        openNewProject(m.name, m.hasProject);
        break;
      case "newProjectFailed": {
        newProjectDone();
        setError($("np-error"), { ...m, message: m.message || "Could not create the project." });
        if (m.openPath) {
          const open = el("button", "secondary small", "Open that folder");
          open.addEventListener("click", () => vscode.postMessage({ type: "openFolder", path: m.openPath }));
          $("np-error").appendChild(document.createElement("br"));
          $("np-error").appendChild(open);
        }
        break;
      }
      case "projectCreated":
        newProjectDone();
        closeNewProject();
        toast("Project created and started", "ok");
        break;
      case "toast":
        toast(m.text, m.level, m);
        break;
      case "atResolved":
        atResolved();
        break;
      case "composer":
        // Another project's composer (or an empty one): its own unsent text replaces this one's,
        // which the host has put away for when that project is shown again.
        view.atPos = -1;
        $("message").value = m.text || "";
        fitInput();
        break;
      case "sessionStart":
        view.startingSession = false;
        if (m.outcome === "started") {
          $("message").value = "";
          fitInput();
          syncDraft();
        } else if (m.outcome === "failed") {
          toast(m.message || "Could not start a new session.", "error", m);
        }
        if (view.state) applyState(view.state);
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
