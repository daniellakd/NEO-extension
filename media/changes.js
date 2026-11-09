// What NEO produced: the Changes strip above the message box (#changes), the review gate's Changes
// section (#gate-changes), and links on tool rows that name a file. The extension host computes
// the changes (src/changes.ts) and opens diffs; this file only draws and asks.
//
// It listens to the same host messages chat.js does and reads nothing of chat.js except
// window.neoPost and the data-part on tool rows. chat.js is loaded first, so its listener has
// already drawn a message by the time this one sees it.
(function () {
  "use strict";

  const post = window.neoPost;
  const $ = (id) => document.getElementById(id);
  const ui = {
    state: null,
    snapshot: null,
    open: false,                 // the strip's list, folded by default
    drawn: "",
    files: new Map(),            // tool part -> { file, title }
  };

  // Tools whose input names one file.
  const FILE_TOOLS = new Set(["edit", "write", "read", "multiedit", "patch"]);
  const STATUS = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // --- the list -----------------------------------------------------------------------------

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  function totals(s, into) {
    into.append(
      el("span", "chg-count", plural(s.files.length, "file") + (s.truncated ? "+" : "")),
      el("span", "chg-add", `+${s.additions}`),
      el("span", "chg-del", `−${s.deletions}`),
    );
  }

  function fileRow(f) {
    const row = el("button", "chg-file");
    row.type = "button";
    const name = f.path.split("/").pop();
    const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, "");
    const what = f.untracked ? "new, not committed yet" : STATUS[f.status] || f.status;
    row.title = `${f.oldPath ? `${f.oldPath} → ` : ""}${f.path}\n${what} — click to open the diff`;
    row.appendChild(el("span", `chg-status s-${f.untracked ? "U" : f.status}`, f.untracked ? "U" : f.status));
    const label = el("span", "chg-path");
    label.append(el("span", "chg-name", name));
    if (dir) label.append(el("span", "chg-dir", dir));
    row.appendChild(label);
    if (f.additions === null) {
      row.appendChild(el("span", "chg-bin", "binary"));
    } else {
      row.append(el("span", "chg-add", `+${f.additions}`), el("span", "chg-del", `−${f.deletions}`));
    }
    row.addEventListener("click", () => post({ type: "changes.diff", path: f.path }));
    return row;
  }

  function fileList(s) {
    const list = el("div", "chg-list");
    s.files.forEach((f) => list.appendChild(fileRow(f)));
    if (s.truncated) list.appendChild(el("div", "chg-note", `Showing the first ${s.files.length} files.`));
    return list;
  }

  function refreshButton() {
    const b = el("button", "chg-refresh", "↻");
    b.type = "button";
    b.title = "Look for changes again";
    b.setAttribute("aria-label", "Refresh changes");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "changes.refresh" });
    });
    return b;
  }

  // --- where it is drawn ---------------------------------------------------------------------

  /** This project's snapshot, or null: a switch can leave the previous project's in flight. */
  function current() {
    const s = ui.snapshot;
    const st = ui.state;
    if (!s || !st || st.mode !== "project" || !st.project || s.project !== st.project.path) return null;
    return s;
  }

  function atReviewGate() {
    const st = ui.state;
    return Boolean(st && st.atGate && st.gate && (st.gate.phase || st.phase) === "review-gate");
  }

  function draw() {
    const s = current();
    const review = atReviewGate();
    const sig = JSON.stringify([s, review, ui.open]);
    if (sig === ui.drawn) return;       // state arrives many times a second while NEO streams
    ui.drawn = sig;
    drawStrip(review ? null : s);
    drawGate(review ? s : null, review);
  }

  /** A folded strip between the chat and the message box, while NEO works and after it is done. */
  function drawStrip(s) {
    const box = $("changes");
    box.innerHTML = "";
    const show = Boolean(s && (s.files.length || s.error));
    box.classList.toggle("hidden", !show);
    if (!show) return;
    const head = el("button", "chg-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(ui.open));
    head.title = s.label;
    head.append(el("span", "chg-caret", ui.open ? "⌄" : "›"), el("span", "chg-title", "Changes"));
    if (s.error) head.appendChild(el("span", "chg-error", "could not read git"));
    else totals(s, head);
    head.appendChild(refreshButton());
    head.addEventListener("click", () => {
      ui.open = !ui.open;
      draw();
    });
    box.appendChild(head);
    if (!ui.open) return;
    if (s.error) {
      box.appendChild(el("div", "chg-note error", s.error));
      return;
    }
    box.appendChild(el("div", "chg-label", s.label));
    box.appendChild(fileList(s));
  }

  /** Inside the review gate card, unfolded: what is about to be approved. */
  function drawGate(s, review) {
    const box = $("gate-changes");
    box.innerHTML = "";
    box.classList.toggle("hidden", !review);
    if (!review) return;
    const head = el("div", "chg-gate-head");
    head.appendChild(el("strong", null, "Changes"));
    if (s && !s.error && s.files.length) totals(s, head);
    head.appendChild(refreshButton());
    box.appendChild(head);
    if (!s) {
      box.appendChild(el("div", "chg-note", "Looking for the files NEO changed…"));
      return;
    }
    if (s.error) {
      box.appendChild(el("div", "chg-note error", `Could not read the changes: ${s.error}`));
      return;
    }
    if (!s.files.length) {
      // "none": nothing to compare was found (the label says why); otherwise a real, empty diff.
      box.appendChild(el("div", "chg-note", s.source === "none"
        ? `No changes found for this session: ${s.label || "no NEO work branch was found"}.`
        : `No file changes in ${s.label}.`));
      return;
    }
    box.appendChild(el("div", "chg-label", s.label));
    box.appendChild(fileList(s));
    box.appendChild(el("div", "chg-note", "Open a file to review its diff before you approve."));
  }

  // --- tool rows that name a file ------------------------------------------------------------

  /** The file a tool event names. Replayed history may carry the input clipped to a JSON string. */
  function fileOf(ev) {
    const input = ev.input;
    if (input && typeof input === "object") return input.filePath || input.file_path || input.path || null;
    if (typeof input === "string") {
      const m = /"(?:filePath|file_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
      if (m) {
        try {
          return JSON.parse(`"${m[1]}"`);
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  function collect(events) {
    for (const ev of events || []) {
      if (ev.kind !== "tool" || !FILE_TOOLS.has(ev.tool) || ev.part === undefined) continue;
      const file = fileOf(ev);
      const prev = ui.files.get(String(ev.part));
      // A part's first events are "pending" with no input yet; keep what a later one names.
      if (file || ev.title) ui.files.set(String(ev.part), { file: file || (prev && prev.file), title: ev.title || (prev && prev.title) });
    }
    decorate();
  }

  function decorate() {
    ui.files.forEach((info, part) => {
      const row = document.querySelector(`.msg.tool[data-part="${CSS.escape(part)}"]`);
      if (!row || row.classList.contains("has-file") || !(info.file || info.title)) return;
      row.classList.add("has-file");
      const title = row.querySelector(".tool-title");
      if (title) title.title = `Open ${info.file || info.title}`;
    });
  }

  // A click on the file name opens it; anywhere else on the row still folds the details.
  $("transcript").addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target.closest(".msg.tool.has-file .tool-title") : null;
    if (!target) return;
    e.preventDefault();
    const info = ui.files.get(target.closest(".msg.tool").dataset.part);
    if (info) post({ type: "changes.openFile", file: info.file || undefined, title: info.title || undefined });
  });

  // --- host messages -------------------------------------------------------------------------

  window.addEventListener("message", (e) => {
    const m = e.data || {};
    switch (m.type) {
      case "state":
        ui.state = m.state;
        draw();
        break;
      case "changes":
        ui.snapshot = m.snapshot;
        draw();
        break;
      case "history":
        ui.files.clear();
        collect(m.events);
        break;
      case "events":
        collect(m.events);
        break;
    }
  });

  post({ type: "changes.ready" });
})();
