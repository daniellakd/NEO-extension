// NEO sidebar: the Design and Plan documents.
//
// Draws what the extension host computes (src/plan.ts) into two containers it owns:
//   #artifacts      a compact row under the live progress: "Design · approved", "Plan · 3/8 tasks";
//                   a chip unfolds the design's sections or the plan's tasks
//   #gate-artifact  inside the gate card, at the Design and Plan gates only: what is being approved
//
// It decides nothing: no status, no task state and no gate is worked out here. It listens to the
// same host messages chat.js does - chat.js is loaded first, so the gate card is already drawn when
// this sees a state - and talks back only through window.neoPost.
(function () {
  "use strict";

  const post = window.neoPost;
  const $ = (id) => document.getElementById(id);
  const ui = {
    open: "",           // the phase whose chip is unfolded, if any
    showAll: false,     // the gate card lists every task, not only the first few
    drawn: "",
    gateKey: "",        // the gate whose raw document was last folded
  };

  const SHOWN = 8;      // sections listed before "+N more"
  const GATE_TASKS = 5; // tasks listed in the gate card before "show all": Approve stays in view

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  /** "10:42", or "3 Nov 10:42" for another day. */
  function when(seconds) {
    if (!seconds) return "";
    const d = new Date(seconds * 1000);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString()
      ? time
      : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
  }

  const STATUS_TEXT = {
    drafting: "being written",
    ready: "ready for review",
    changes: "changes requested",
    approved: "approved",
  };

  /** The chip's short status: a plan under way says how far it is instead. */
  function statusText(item) {
    if (item.atGate) return "awaiting your approval";
    if (item.kind === "plan" && item.current && item.status === "approved") {
      return item.current.complete
        ? `all ${item.current.total} tasks done`
        : `task ${item.current.index} of ${item.current.total}`;
    }
    return STATUS_TEXT[item.status] || item.status;
  }

  /** Every step so far, for the tooltip: "ready 10:31 → changes requested 10:35 → approved 10:42". */
  function historyText(item) {
    const steps = (item.history || []).map((h) => `${STATUS_TEXT[h.status] || h.status} ${when(h.at)}`.trim());
    return [`${item.label} · ${item.path}`, steps.join(" → ")].filter(Boolean).join("\n");
  }

  // --- pieces --------------------------------------------------------------------------------

  function actions(item) {
    const row = el("div", "art-actions");
    const preview = el("button", "art-preview", `Preview ${item.label.toLowerCase()}`);
    preview.type = "button";
    preview.title = `Open ${item.path} as a read-only preview. To change it, use Request Changes at its gate.`;
    preview.addEventListener("click", () => post({ type: "plan.open", phase: item.phase, as: "preview" }));
    const source = el("button", "art-source", "Open file");
    source.type = "button";
    source.title = `Open ${item.path} in the editor`;
    source.addEventListener("click", () => post({ type: "plan.open", phase: item.phase, as: "source" }));
    row.append(preview, source);
    return row;
  }

  const MARK = { done: "✓", current: "→", todo: "○" };

  function taskList(item, limit) {
    const tasks = item.tasks || [];
    const list = el("ol", "art-tasks");
    tasks.slice(0, limit || tasks.length).forEach((t) => {
      const li = el("li", `art-task ${t.state}`);
      li.appendChild(el("span", "art-mark", MARK[t.state] || "○"));
      const title = el("span", "art-task-title", t.title);
      title.title = t.title;
      li.appendChild(title);
      if (t.steps) li.appendChild(el("span", "art-steps", plural(t.steps, "step")));
      list.appendChild(li);
    });
    return list;
  }

  function sectionList(item, limit) {
    const list = el("ul", "art-sections");
    (item.sections || []).slice(0, limit).forEach((s) => {
      const li = el("li", null, s);
      li.title = s;
      list.appendChild(li);
    });
    return list;
  }

  /** "8 tasks · 37 steps", "7 sections". */
  function sizeText(item) {
    if (item.kind === "plan") {
      const tasks = (item.tasks || []).length;
      if (!tasks) return "";
      return item.steps && item.steps !== tasks ? `${plural(tasks, "task")} · ${plural(item.steps, "step")}` : plural(tasks, "task");
    }
    const n = (item.sections || []).length;
    return n ? plural(n, "section") : "";
  }

  function more(count, label, onClick) {
    const b = el("button", "art-more", `Show all ${count} ${label}`);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  /** The body of an unfolded chip, and of the gate card's summary. */
  function body(item, inGate) {
    const box = el("div", "art-body");
    if (item.title) box.appendChild(el("div", "art-doc-title", item.title));
    if (item.feedback) {
      const fb = el("div", "art-feedback");
      // Neutral on purpose: a request can be the user's or one of NEO's own checks, and the
      // gate events do not reliably say which.
      fb.appendChild(el("span", "art-feedback-label", item.atGate ? "Changes requested last time: " : "Changes requested: "));
      fb.appendChild(document.createTextNode(item.feedback));
      box.appendChild(fb);
    }
    if (item.kind === "plan") {
      const tasks = item.tasks || [];
      if (tasks.length) {
        const limit = inGate && !ui.showAll ? GATE_TASKS : 0;
        box.appendChild(taskList(item, limit));
        if (limit && tasks.length > limit) {
          box.appendChild(more(tasks.length, "tasks", () => {
            ui.showAll = true;
            redraw();
          }));
        }
      } else {
        box.appendChild(el("div", "art-note", "The plan's tasks are not available here - preview the plan to read it."));
      }
    } else if ((item.sections || []).length) {
      box.appendChild(sectionList(item, SHOWN));
      if (item.sections.length > SHOWN) box.appendChild(el("div", "art-note", `+${item.sections.length - SHOWN} more sections`));
    } else {
      box.appendChild(el("div", "art-note", "Preview the document to read it."));
    }
    box.appendChild(actions(item));
    return box;
  }

  // --- the row under the live progress ---------------------------------------------------------

  function drawStrip(items) {
    const box = $("artifacts");
    box.innerHTML = "";
    box.classList.toggle("hidden", !items.length);
    if (!items.length) return;
    const row = el("div", "art-chips");
    items.forEach((item) => {
      const chip = el("button", `art-chip ${item.kind} s-${item.atGate ? "gate" : item.status}`);
      chip.type = "button";
      chip.title = historyText(item);
      chip.setAttribute("aria-expanded", String(ui.open === item.phase && !item.atGate));
      chip.appendChild(el("span", "art-icon"));
      chip.appendChild(el("span", "art-label", item.label));
      chip.appendChild(el("span", "art-status", statusText(item)));
      chip.addEventListener("click", () => {
        // At its gate the card already shows it: bring the card into view instead.
        if (item.atGate) {
          const gate = $("gate");
          if (gate) gate.scrollIntoView({ block: "nearest", behavior: "smooth" });
          return;
        }
        ui.open = ui.open === item.phase ? "" : item.phase;
        redraw();
      });
      row.appendChild(chip);
    });
    box.appendChild(row);
    const open = items.find((i) => i.phase === ui.open && !i.atGate);
    if (open) {
      const panel = body(open, false);
      panel.classList.add("art-panel");
      box.appendChild(panel);
    }
  }

  // --- the gate card ---------------------------------------------------------------------------

  /**
   * At a Design or Plan gate: what is being approved, in a few lines, above the raw document - which
   * is folded once when the gate opens (chat.js unfolds it on every new gate), still one click away.
   */
  function drawGate(items, state) {
    const box = $("gate-artifact");
    const item = items.find((i) => i.atGate);
    box.innerHTML = "";
    box.classList.toggle("hidden", !item);
    if (!item) {
      ui.gateKey = "";
      return;
    }
    const head = el("div", "art-gate-head");
    head.appendChild(el("strong", null, `${item.label} gate`));
    const size = sizeText(item);
    if (size) head.appendChild(el("span", "art-size", size));
    box.appendChild(head);
    box.appendChild(el("div", "art-ask", item.kind === "plan"
      ? "Approving starts Execute: NEO builds these tasks in order."
      : "Approving lets NEO write the plan from this design."));
    box.appendChild(body(item, true));

    const key = `${item.phase}|${state.gate && state.gate.artifact ? state.gate.artifact.length : 0}`;
    if (key !== ui.gateKey) {
      ui.gateKey = key;
      ui.showAll = false;
      const doc = $("gate-doc");
      if (doc) doc.open = false;
    }
  }

  // --- host messages -------------------------------------------------------------------------

  let last = null;

  function redraw() {
    if (!last) return;
    const items = last.mode === "project" && last.artifacts ? last.artifacts.items : [];
    drawStrip(items);
    drawGate(items, last);
  }

  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type !== "state") return;
    last = m.state;
    const items = last.mode === "project" && last.artifacts ? last.artifacts.items : [];
    // State arrives many times a second while NEO streams: redraw only when this part changed.
    const sig = JSON.stringify([items, ui.open, ui.showAll, last.gate && last.gate.phase]);
    if (sig === ui.drawn) return;
    ui.drawn = sig;
    if (ui.open && !items.some((i) => i.phase === ui.open)) ui.open = "";
    redraw();
  });
})();
