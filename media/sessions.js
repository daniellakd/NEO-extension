// NEO sidebar: sessions and "since you were away".
//
// Draws what the extension host computes (src/sessions.ts, src/sessionHistory.ts):
//   #away         a dismissible card: what NEO stored after the user last saw this project, and
//                 where things stand now
//   #transcript   three kinds of marker placed among chat.js's rows, by the `data-seq` it stamps:
//                   - the session the transcript starts in, at the top (current or earlier)
//                   - a separator where a later session starts
//                   - "New since your last visit", before the first event the user had not seen
//
// It decides nothing and talks to NEO not at all: it reads the `state` the host posts, and asks the
// host through window.neoPost to open the read-only session list or a session snapshot. chat.js is
// loaded first, so on every message the transcript rows are already drawn when this runs.
(function () {
  "use strict";

  const post = window.neoPost;
  const $ = (id) => document.getElementById(id);
  const ui = {
    s: null,          // state.sessions
    project: false,   // a project is shown
    awaySig: "",
    headSig: "",
    dismissed: "",    // the card the user closed, so a repaint does not bring it back
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function link(text, title, onClick) {
    const b = el("button", "link", text);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  /** "10:42" today, "3 Nov 10:42" another day. `seconds` is NEO's clock; `ms` this machine's. */
  function when(seconds, ms) {
    const t = ms || (seconds ? seconds * 1000 : 0);
    if (!t) return "";
    const d = new Date(t);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === new Date().toDateString()) return time;
    return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
  }

  // --- since you were away -----------------------------------------------------------------

  function drawAway() {
    const box = $("away");
    const a = ui.project && ui.s ? ui.s.away : null;
    const sig = a ? JSON.stringify(a) : "";
    if (!a || sig === ui.dismissed) {
      box.classList.add("hidden");
      box.replaceChildren();
      ui.awaySig = "";
      return;
    }
    if (sig === ui.awaySig) return;
    ui.awaySig = sig;
    box.replaceChildren();
    box.classList.remove("hidden");

    const head = el("div", "away-head");
    const title = el("strong", null, a.kind === "first" ? "Where NEO stands" : "Since you were away");
    head.appendChild(title);
    if (a.since) head.appendChild(el("span", "muted small", `last visit ${when(0, a.since)}`));
    const close = el("button", "icon away-close", "×");
    close.type = "button";
    close.title = "Dismiss";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", () => {
      ui.dismissed = sig;
      drawAway();
      post({ type: "sessions.dismiss" });
    });
    head.appendChild(close);
    box.appendChild(head);

    if (a.items && a.items.length) {
      const ul = el("ul", "away-items");
      a.items.forEach((it) => {
        const li = el("li", null, it.text);
        if (it.at) li.appendChild(el("span", "muted small away-at", when(it.at)));
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
    (a.notes || []).forEach((n) => box.appendChild(el("p", "muted small away-note", n)));
    if (a.now) {
      const now = el("div", "away-now");
      now.append(el("span", "away-now-label", "Now"), el("span", null, a.now));
      box.appendChild(now);
    }
    const actions = el("div", "away-actions");
    if (ui.s.newFrom !== null && ui.s.newFrom !== undefined) {
      actions.appendChild(link("Show what's new", "Scroll to the first event since your last visit", () => {
        const mark = document.querySelector("#transcript .sessions-new");
        if (mark) mark.scrollIntoView({ block: "start", behavior: "smooth" });
      }));
    }
    if (ui.s.supported && ui.s.list.length > 1) {
      actions.appendChild(link("Sessions…", "Every session of this project, read-only", () => post({ type: "sessions.pick" })));
    }
    if (actions.childElementCount) box.appendChild(actions);
  }

  // --- markers in the transcript -----------------------------------------------------------

  function rows() {
    return [...document.querySelectorAll("#transcript > [data-seq]")];
  }

  /** The row to put a marker before: the first drawn at or after `seq`, with its "NEO" label. */
  function anchorRow(seq) {
    const row = rows().find((r) => Number(r.dataset.seq) >= seq);
    if (!row) return null;
    const prev = row.previousElementSibling;
    return prev && prev.classList.contains("turn-label") ? prev : row;
  }

  function sessionLine(cls, tag, s, extra) {
    const line = el("div", `session-mark ${cls}`);
    line.appendChild(el("span", `session-tag ${s.active ? "current" : "previous"}`, tag));
    line.appendChild(el("span", "session-title", s.title));
    const facts = [s.kind, `started ${when(s.createdAt)}`];
    if (!s.active && s.endedAt) facts.push(`ended ${when(s.endedAt)}`);
    if (s.count > 1) facts.push(`${s.index} of ${s.count}`);
    line.appendChild(el("span", "session-facts muted", facts.join(" · ")));
    if (extra) line.appendChild(extra);
    return line;
  }

  function drawMarkers() {
    const t = $("transcript");
    const s = ui.project ? ui.s : null;
    const first = rows()[0];
    const sig = s && first
      ? JSON.stringify([s.list.map((r) => [r.id, r.firstEvent, r.active, r.endedAt, r.title]), s.hiddenEarlier, s.newFrom])
      : "";
    if (sig !== ui.headSig) {
      t.querySelectorAll(".session-head, .session-sep, .sessions-new").forEach((n) => n.remove());
      ui.headSig = sig;
    }
    if (!s || !first) return;                       // nothing drawn yet: leave chat.js's empty state alone

    // The session the transcript starts in: the last one begun at or before its first row.
    if (s.supported && s.list.length) {
      const firstSeq = Number(first.dataset.seq);
      const begun = s.list.filter((r) => r.firstEvent !== null && r.firstEvent <= firstSeq);
      const head = begun.length ? begun[begun.length - 1] : s.active || s.list[s.list.length - 1];
      if (head && !t.querySelector(".session-head")) {
        const tools = el("span", "session-tools");
        if (s.list.length > 1) tools.appendChild(link("Sessions…", "Every session of this project, read-only", () => post({ type: "sessions.pick" })));
        const node = sessionLine("session-head", head.active ? "Current session" : "Earlier session", head, tools);
        if (head.active && s.hiddenEarlier > 0) {
          const more = el("div", "session-more muted");
          more.appendChild(el("span", null, `${s.hiddenEarlier} earlier event${s.hiddenEarlier === 1 ? "" : "s"} of this session are not shown here. `));
          more.appendChild(link("Open the full session", "A read-only snapshot; the sidebar is not changed", () => post({ type: "sessions.open", id: head.id })));
          node.appendChild(more);
        }
        t.insertBefore(node, t.firstChild);
      }
      // A later session that began while this transcript was open.
      s.list.forEach((r) => {
        if (r === head || r.firstEvent === null || r.firstEvent <= firstSeq) return;
        if (t.querySelector(`.session-sep[data-session="${CSS.escape(r.id)}"]`)) return;
        const at = anchorRow(r.firstEvent);
        if (!at) return;
        const sep = sessionLine("session-sep", r.active ? "New session · current" : "Session", r);
        sep.dataset.session = r.id;
        t.insertBefore(sep, at);
      });
    }

    // New since the last visit.
    if (s.newFrom !== null && s.newFrom !== undefined && !t.querySelector(".sessions-new")) {
      const at = anchorRow(s.newFrom);
      if (at && at !== rows()[0]) t.insertBefore(el("div", "divider sessions-new", "New since your last visit"), at);
    }
  }

  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "state") {
      const st = m.state || {};
      ui.project = st.mode === "project";
      ui.s = st.sessions || null;
      drawAway();
      drawMarkers();
    } else if (m.type === "history" || m.type === "events") {
      if (m.type === "history") ui.headSig = "";   // chat.js has just emptied the transcript
      drawMarkers();
    }
  });
})();
