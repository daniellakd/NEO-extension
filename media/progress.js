// NEO sidebar: the live progress panel.
//
// Owns one container (#live) and nothing else, so it can grow without touching the chat. It draws
// the `live` object the extension host computes (src/progress.ts) and never decides anything
// itself: no phase, no count and no state is worked out here.
//
// Shown, top to bottom, only when there is something to say:
//   Task 3 of 8 - Implement CRUD routes      (the plan step being worked on)
//   [=====------]  3 of 8 done               (how much of the plan is complete)
//   * Editing main.py                        (what NEO is doing right now)
//   ! Waiting on you: ...                    (stalled / interrupted / stopped / reconnecting)
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // State is posted many times a second while NEO streams. The panel is rebuilt only when what it
  // shows actually changed, so the countdown below can keep its own tick and nothing flickers.
  const seen = { sig: "", timer: null, retryAt: 0 };

  function signature(live) {
    if (!live) return "none";
    return JSON.stringify([
      live.activity,
      live.task,
      live.progress,
      live.action,
      live.note,
      live.stream.state,
      Boolean(live.stream.catchingUp),
    ]);
  }

  /** "retrying in 4s" - a live countdown while the stream is down, and nothing otherwise. */
  function tick() {
    const box = $("live-retry");
    if (!box) return;
    const left = Math.max(0, Math.round((seen.retryAt - Date.now()) / 1000));
    box.textContent = seen.retryAt ? (left > 0 ? ` - retrying in ${left}s` : " - retrying now") : "";
  }

  function stopTick() {
    if (seen.timer) clearInterval(seen.timer);
    seen.timer = null;
    seen.retryAt = 0;
  }

  function taskRow(task) {
    const row = el("div", "live-task");
    row.appendChild(el("span", "live-step", `Task ${task.index} of ${task.total}`));
    if (task.title) {
      row.appendChild(el("span", "live-sep", "·"));
      const title = el("span", "live-title", task.title);
      title.title = task.title;                 // the full title when the sidebar is narrow
      row.appendChild(title);
    }
    return row;
  }

  function progressRow(progress) {
    const done = Math.max(0, Math.min(progress.done, progress.total));
    const row = el("div", "live-progress");
    const bar = el("div", "live-bar");
    const fill = el("div", "live-fill");
    fill.style.width = `${Math.round((done / progress.total) * 100)}%`;
    if (done >= progress.total) fill.classList.add("full");
    bar.appendChild(fill);
    row.appendChild(bar);
    const count = el("span", "live-count", `${done} of ${progress.total} done`);
    count.title = `${done} of ${progress.total} plan tasks complete`;
    row.appendChild(count);
    return row;
  }

  function actionRow(text) {
    const row = el("div", "live-action");
    row.appendChild(el("span", "spinner"));
    const label = el("span", "live-action-text", text);
    label.title = text;
    row.appendChild(label);
    return row;
  }

  function noteRow(note) {
    const row = el("div", `live-note ${note.tone}`);
    row.appendChild(el("span", "live-note-mark", note.tone === "warn" ? "!" : "·"));
    const text = el("span", "live-note-text", note.text);
    text.title = note.text;
    row.appendChild(text);
    return row;
  }

  /**
   * The stream, when it is not simply up. Said once, here - the connection dot in the header says
   * *that* it is down, this line says what that means and what happens next.
   */
  function streamRow(stream) {
    if (stream.state === "reconnecting") {
      const row = el("div", "live-note warn");
      row.appendChild(el("span", "spinner"));
      const text = el("span", "live-note-text");
      text.appendChild(document.createTextNode("Live updates paused - reconnecting"));
      const retry = el("span", "live-retry");
      retry.id = "live-retry";
      text.appendChild(retry);
      row.appendChild(text);
      row.title = "The event stream dropped. NEO keeps working; the sidebar still re-reads the "
        + "project every 10 seconds, and catches up on everything it missed when the stream is back.";
      return row;
    }
    if (stream.catchingUp) {
      const row = el("div", "live-note ok");
      row.appendChild(el("span", "spinner"));
      row.appendChild(el("span", "live-note-text", "Reconnected - catching up on what was missed"));
      return row;
    }
    return null;
  }

  function render(live) {
    const box = $("live");
    if (!box) return;
    const sig = signature(live);
    if (sig === seen.sig) {
      // Unchanged, except the countdown, which keeps running on its own interval.
      if (live && live.stream.state === "reconnecting") seen.retryAt = live.stream.retryAt || 0;
      return;
    }
    seen.sig = sig;
    stopTick();
    box.innerHTML = "";
    if (!live) {
      box.classList.add("hidden");
      return;
    }

    const rows = [];
    // Whether a plan is worth showing at all is the host's call (src/progress.ts): it sends the
    // progress only when it means something, so there is only ever one rule for it.
    const onPlan = Boolean(live.progress && live.progress.total > 0);
    if (onPlan && live.task) rows.push(taskRow(live.task));
    if (onPlan) rows.push(progressRow(live.progress));
    if (live.action) rows.push(actionRow(live.action));
    const stream = streamRow(live.stream);
    if (stream) rows.push(stream);
    // A stall and a dropped stream at once: the stream line already explains the silence.
    if (live.note && !stream) rows.push(noteRow(live.note));

    rows.forEach((r) => box.appendChild(r));
    box.classList.toggle("hidden", rows.length === 0);
    box.dataset.activity = live.activity;

    if (live.stream.state === "reconnecting") {
      seen.retryAt = live.stream.retryAt || 0;
      tick();
      seen.timer = setInterval(tick, 1000);
    }
  }

  window.NeoProgress = { render };
})();
