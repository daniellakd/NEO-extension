/**
 * Sessions, history and "since you were away": the pure part.
 *
 * Everything here is worked out from what NEO stored - its sessions, its persisted stream events
 * (each with a `seq`, the database row id) and its gate audit trail - plus one thing the extension
 * keeps itself: the last event the user actually had on screen, per project (`SeenAnchor`).
 *
 * Rules this file keeps:
 *   - A count is only ever a count of stored events. When not every event since the last visit
 *     could be read, the summary says so and the counts read as minimums.
 *   - A time is only ever a time NEO stored (a session's start or end, a gate decision) or the
 *     moment this extension recorded the user's last visit. Stream events carry no time, so none is
 *     made up for them.
 *   - Nothing here decides a phase, a gate or a session; it only describes them.
 *
 * No VS Code API in here, on purpose: it is unit-tested directly (src/test/sessions.test.ts).
 */

import type { GateEvent, NeoEvent, NeoSession, SessionKind } from "./neoClient";

// --- labels ------------------------------------------------------------------------------

/** NEO's own names for its session kinds (orchestrator SESSION_KINDS), used until it sends them. */
const KIND_LABELS: Record<string, string> = { full: "Full pipeline", prd: "Quick plan", quick: "Quick change" };

export function kindLabel(kind: string | undefined, kinds?: Record<string, SessionKind>): string {
  const k = String(kind || "");
  return kinds?.[k]?.label || KIND_LABELS[k] || k || "session";
}

export interface StageLabel {
  phase: string;
  label: string;
}

/** "plan-gate" -> the rail's own label when NEO sent one, else "Plan gate". */
export function phaseLabel(phase: string | undefined, stages?: StageLabel[]): string {
  const p = String(phase || "");
  const stage = stages?.find((s) => s.phase === p);
  if (stage?.label) return stage.label;
  const words = p.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "an unknown phase";
}

// User messages NEO writes itself carry a `note` naming their role (sessions.py `role_note`). Only
// a message without one was typed by a person; "answer" is a person's reply to a question.
const HUMAN_NOTES = new Set(["", "answer"]);
const KICKOFF_NOTES = new Set(["kickoff", "new session"]);

export function isHumanMessage(ev: NeoEvent): boolean {
  return ev.kind === "user" && HUMAN_NOTES.has(String(ev.note ?? ""));
}

/** The notices that stop for the user (chat.js `noticeNeedsUser`). */
export function noticeNeedsUser(ev: NeoEvent): boolean {
  return Boolean(ev.stalled || ev.runaway || ev.timeout || ev.held || ev.repair_stuck || (ev.incomplete && ev.exhausted));
}

/** A notice in words (a subset of chat.js `noticeText`, enough for a summary and the viewer). */
export function noticeText(ev: NeoEvent): string {
  if (ev.stalled) return `${String(ev.stalled)} — NEO waited for guidance`;
  if (ev.runaway) return "runaway output — the turn was aborted";
  if (ev.timeout) return `no activity for ${String(ev.timeout)}s — the turn was aborted`;
  if (ev.auto_approved) return `${String(ev.auto_approved)} approved automatically — every check passed`;
  if (ev.incomplete) {
    return ev.exhausted
      ? `execution incomplete — ${String(ev.count)} plan step(s) unticked; NEO waited for you`
      : `not finished — ${String(ev.count)} plan step(s) unticked, NEO continued`;
  }
  if (ev.resumed) return `a turn in ${String(ev.resumed)} was cut off by a restart — NEO resumed it`;
  if (ev.held) return `${String(ev.held)} held for you: ${String(ev.failed ?? "")}`.trim();
  if (ev.repair_stuck) return `automatic repair stopped on ${String(ev.repair_stuck)} — the gate opened for you`;
  if (ev.repair) return `refused “${String(ev.repair)}” — ${String(ev.failed ?? "checks")} still failing`;
  if (ev.unearned) return `refused “${String(ev.unearned)}”: the turn did no work`;
  if (ev.ignored) return `ignored an out-of-order signal (${String(ev.ignored)})`;
  if (ev.missing_signal) return `completion claimed with no signal — NEO asked for “${String(ev.missing_signal)}”`;
  return `notice in ${String(ev.phase || "this phase")}`;
}

const DECISIONS: Record<string, string> = {
  approved: "approved",
  "auto-approved": "approved automatically (every check passed)",
  rejected: "changes requested",
  override: "approved despite failing checks",
};

/** A gate decision in words, or undefined for audit rows that are not decisions (detected, blocked…). */
export function decisionText(g: GateEvent, stages?: StageLabel[]): string | undefined {
  const verb = DECISIONS[g.action];
  return verb ? `${phaseLabel(g.phase, stages)}: ${verb}` : undefined;
}

// --- the last-seen anchor ----------------------------------------------------------------

/** What the user had on screen the last time the sidebar showed this project. */
export interface SeenAnchor {
  /** The newest persisted event (`seq`) delivered to a visible, focused sidebar. */
  seq: number;
  /** The active NEO session then. */
  session: string | null;
  /** The newest gate decision time known then (NEO's clock, seconds). */
  gateAt: number;
  /** The plan progress shown then. */
  plan?: { done: number; total: number } | null;
  /** When it was recorded: this machine's clock, milliseconds. */
  at: number;
}

export function anchorKey(server: string, projectId: string): string {
  return `neo.sessions.seen:${server}:${projectId}`;
}

/** Whether `events` holds every event of the session newer than `anchorSeq`. */
export function covers(anchorSeq: number, events: NeoEvent[], total: number, shown: number): boolean {
  if (shown >= total) return true;                   // the whole session was read
  const oldest = minSeq(events);
  // An event at or before the anchor was read, so nothing newer than it is missing.
  return oldest !== undefined && oldest <= anchorSeq;
}

export function minSeq(events: NeoEvent[]): number | undefined {
  let m: number | undefined;
  for (const e of events) if (typeof e.seq === "number" && (m === undefined || e.seq < m)) m = e.seq;
  return m;
}

export function maxGateAt(gates: GateEvent[] | undefined): number {
  return (gates ?? []).reduce((m, g) => (typeof g.created_at === "number" && g.created_at > m ? g.created_at : m), 0);
}

// --- since you were away -----------------------------------------------------------------

/** The current state, as the sidebar already shows it. */
export interface NowInput {
  phase?: string;
  busy: boolean;
  atGate: boolean;
  gate?: { title?: string; phase?: string } | null;
  awaiting: boolean;
  needsAttention: boolean;
  attentionReason?: string | null;
  stages?: StageLabel[];
}

export interface AwayItem {
  text: string;
  /** NEO's clock, seconds - only for facts NEO stored a time for. */
  at?: number;
}

export interface AwaySummary {
  /** first: no record of a last visit. mismatch: NEO's history no longer lines up with it. */
  kind: "first" | "activity" | "mismatch";
  /** The last visit, this machine's clock (ms). */
  since?: number;
  items: AwayItem[];
  /** What could not be determined, said plainly. */
  notes: string[];
  /** Not every event since the last visit could be read: counts are minimums. */
  partial: boolean;
  /** Where things stand now, in one line. */
  now: string | null;
  /** The first new event the transcript draws: where "new since your last visit" goes. */
  firstNewSeq: number | null;
}

export interface AwayInput {
  /** open: the project was just opened. return: the user came back to an open sidebar. */
  trigger: "open" | "return";
  anchor: SeenAnchor | undefined;
  /** Events read since the anchor (anything older is ignored). */
  events: NeoEvent[];
  /** Every event of the active session newer than the anchor is in `events`. */
  complete: boolean;
  /** The newest event seq known for the project now. */
  newestSeq: number;
  sessions?: NeoSession[];
  activeSession: string | null;
  kinds?: Record<string, SessionKind>;
  gateEvents?: GateEvent[];
  plan?: { done: number; total: number } | null;
  now: NowInput;
}

// Kinds the transcript draws (chat.js render), for placing the "new" divider.
const DRAWN = new Set(["user", "text", "tool", "question", "notice", "phase", "gate", "error"]);

/**
 * What happened since the user last had this project on screen, or null when nothing worth saying
 * did. Only stored facts; see the file comment.
 */
export function awaySummary(input: AwayInput): AwaySummary | null {
  const { anchor, now } = input;
  const nowLine = describeNow(now);

  if (!anchor) {
    if (input.trigger === "return") return null;
    if (!input.newestSeq && !(input.sessions && input.sessions.length)) return null;   // nothing stored yet
    return {
      kind: "first",
      items: [],
      notes: [
        "There is no record of your last visit to this project in this VS Code, so what happened while you were away " +
          "cannot be told apart from what you already saw. From now on the sidebar remembers what you have seen.",
      ],
      partial: false,
      now: nowLine,
      firstNewSeq: null,
    };
  }

  if (input.newestSeq > 0 && anchor.seq > input.newestSeq) {
    return {
      kind: "mismatch",
      since: anchor.at,
      items: [],
      notes: [
        "NEO's stored history for this project ends before your last visit - it may have been reset or restored - " +
          "so nothing can be compared. The summary starts again from now.",
      ],
      partial: false,
      now: nowLine,
      firstNewSeq: null,
    };
  }

  const items: AwayItem[] = [];
  const notes: string[] = [];
  let notable = false;
  const stages = now.stages;

  // Sessions: started, ended, or the one last seen gone.
  const sessions = input.sessions;
  if (sessions && sessions.length && anchor.session) {
    const idx = sessions.findIndex((s) => s.id === anchor.session);
    if (idx < 0) {
      notes.push("The session you last saw is no longer in NEO's records.");
    } else {
      const seen = sessions[idx];
      if (seen.ended_at) {
        items.push({ text: `Session “${seen.title}” ended`, at: seen.ended_at });
        notable = true;
      }
      for (const s of sessions.slice(idx + 1)) {
        items.push({ text: `New session started: “${s.title}” (${kindLabel(s.kind, input.kinds)})`, at: s.created_at });
        notable = true;
      }
      if (seen.id !== input.activeSession && typeof seen.last_event === "number" && seen.last_event > anchor.seq) {
        notes.push(`“${seen.title}” had more activity after your last visit. Open it from Sessions to read it.`);
      }
    }
  }

  // Events since the anchor, each once.
  const bySeq = new Map<number, NeoEvent>();
  for (const e of input.events) if (typeof e.seq === "number" && e.seq > anchor.seq) bySeq.set(e.seq, e);
  const fresh = [...bySeq.values()].sort((a, b) => (a.seq as number) - (b.seq as number));
  const partial = !input.complete;
  const n = (count: number, one: string, many = `${one}s`) => `${partial ? "at least " : ""}${count} ${count === 1 ? one : many}`;

  const path: string[] = [];
  const gates: string[] = [];
  let questions = 0;
  let human = 0;
  let errors = 0;
  const texts = new Set<string>();
  const tools = new Set<string>();
  const attention: NeoEvent[] = [];
  for (const e of fresh) {
    switch (e.kind) {
      case "phase": {
        const p = String(e.phase ?? "");
        if (p && !p.endsWith("-gate")) {
          const label = p === "done" ? "Done" : phaseLabel(p, stages);
          if (path[path.length - 1] !== label) path.push(label);
        }
        break;
      }
      case "gate":
        gates.push(String(e.title || phaseLabel(e.phase as string | undefined, stages)));
        break;
      case "question":
        questions++;
        break;
      case "user":
        if (isHumanMessage(e)) human++;
        break;
      case "text":
        texts.add(String(e.part ?? e.seq));
        break;
      case "tool":
        tools.add(String(e.part ?? e.seq));
        break;
      case "notice":
        if (noticeNeedsUser(e)) attention.push(e);
        break;
      case "error":
        errors++;
        break;
    }
  }
  if (path.length) {
    items.push({ text: `Moved to ${path.join(" → ")}` });
    notable = true;
  }
  // A gate reached again after changes were requested is one line, with how often.
  const reached = new Map<string, number>();
  for (const g of gates) reached.set(g, (reached.get(g) ?? 0) + 1);
  for (const [g, times] of reached) {
    items.push({ text: `Reached the gate: ${g}${times > 1 ? ` (${n(times, "time")})` : ""}` });
    notable = true;
  }
  for (const g of (input.gateEvents ?? []).filter((g) => g.created_at > anchor.gateAt)) {
    const text = decisionText(g, stages);
    if (!text) continue;
    items.push({ text, at: g.created_at });
    notable = true;
  }
  if (questions) {
    items.push({ text: `NEO asked ${n(questions, "question")}` });
    notable = true;
  }
  if (human) {
    items.push({ text: `${capital(n(human, "message"))} sent to NEO` });
    notable = true;
  }
  if (attention.length) {
    const last = attention[attention.length - 1];
    items.push({
      text: attention.length > 1 ? `NEO stopped for you ${n(attention.length, "time")}; the last: ${noticeText(last)}` : `NEO stopped for you: ${noticeText(last)}`,
    });
    notable = true;
  }
  if (errors) {
    items.push({ text: `${capital(n(errors, "error"))} reported` });
    notable = true;
  }
  const plan = input.plan;
  if (anchor.plan && plan && plan.total > 0) {
    if (plan.total === anchor.plan.total && plan.done > anchor.plan.done) {
      items.push({ text: `Plan: ${anchor.plan.done} → ${plan.done} of ${plan.total} steps ticked` });
    } else if (plan.total !== anchor.plan.total) {
      items.push({ text: `Plan progress is now ${plan.done} of ${plan.total} steps (was ${anchor.plan.done} of ${anchor.plan.total})` });
    }
  }
  if (texts.size || tools.size) {
    const parts = [texts.size ? `wrote ${n(texts.size, "message")}` : "", tools.size ? `ran ${n(tools.size, "tool action")}` : ""].filter(Boolean);
    items.push({ text: `NEO ${parts.join(" and ")}` });
  }

  if (partial) {
    notes.unshift("More happened than this sidebar could read (only the latest events are loaded), so the counts are minimums.");
  }

  // Coming back to a window that stayed open: only what changes the picture is worth a card.
  if (input.trigger === "return" && !notable) return null;
  if (!items.length && !notes.length) return null;

  const firstNew = fresh.find((e) => DRAWN.has(e.kind));
  return {
    kind: "activity",
    since: anchor.at,
    items,
    notes,
    partial,
    now: nowLine,
    firstNewSeq: firstNew ? (firstNew.seq as number) : null,
  };
}

/** Where things stand, in one line - from the state the sidebar already holds. */
export function describeNow(s: NowInput): string | null {
  if (!s.phase) return null;
  const label = phaseLabel(s.phase, s.stages);
  if (s.atGate) return s.gate?.title ? `Waiting for your decision at the gate: ${s.gate.title}` : `Waiting for your decision at ${label}`;
  if (s.awaiting) return "Waiting for your answer to NEO's question";
  if (s.needsAttention) return `Waiting on you: ${s.attentionReason || "NEO needs guidance"}`;
  if (s.busy) return `NEO is working · ${label}`;
  if (s.phase === "done") return "Finished · nothing is running";
  return `Nothing is running · ${label}. NEO continues when you send a message.`;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- the read-only session document ------------------------------------------------------

/** "2026-11-03 14:05", local time: a fixed shape, whatever the locale. */
export function formatTime(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const d = new Date(seconds * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Text safe to put inline in Markdown: the characters that would start markup are escaped. */
export function mdInline(text: unknown): string {
  return String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_[\]<>#|])/g, "\\$1");
}

function codeSpan(text: unknown): string {
  const s = String(text ?? "").replace(/[\r\n]+/g, " ").replace(/`/g, "'");
  return `\`${s}\``;
}

function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
}

function clipText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// chat.js / context.ts put attached files after this line; the viewer shows the user's own words.
const CONTEXT_MARKER = "\n\n--- Attached from VS Code ---\n";

export interface SessionDocInput {
  projectName: string;
  session: NeoSession;
  /** 1-based position among the project's sessions, and how many there are. */
  index: number;
  count: number;
  /** The session the sidebar follows (the newest). */
  active: boolean;
  kinds?: Record<string, SessionKind>;
  events: NeoEvent[];
  total: number;
  shown: number;
  gateEvents?: GateEvent[];
  stages?: StageLabel[];
  /** When this snapshot was read (seconds). */
  takenAt: number;
}

/** One session as a read-only Markdown document: what was asked, how it went, its history. */
export function sessionMarkdown(input: SessionDocInput): string {
  const { session: s, stages } = input;
  const out: string[] = [];
  out.push(`# ${mdInline(s.title || "Session")}`);
  out.push(
    `> **Read-only snapshot** of NEO's stored history, read ${formatTime(input.takenAt)}. ` +
      "Viewing it does not change the active session, restart any work, or modify the project. " +
      "To act on the project, use the NEO sidebar.",
  );
  out.push(
    [
      "| | |",
      "|---|---|",
      `| Project | ${mdInline(input.projectName)} |`,
      `| Session | ${input.index} of ${input.count} |`,
      `| Type | ${mdInline(kindLabel(s.kind, input.kinds))} |`,
      `| Status | ${input.active ? "**Active** · the session the NEO sidebar follows" : s.ended_at ? "Ended" : "Not active"} |`,
      `| Started | ${formatTime(s.created_at)} |`,
      `| Ended | ${s.ended_at ? formatTime(s.ended_at) : input.active ? "— (still active)" : "—"} |`,
      ...(typeof s.messages === "number" ? [`| Messages | ${s.messages} |`] : []),
      `| Stored events | ${input.total} |`,
    ].join("\n"),
  );

  out.push("## Request");
  const request = String(s.request ?? "").trim();
  if (!request) out.push("_No request was recorded for this session._");
  else if (request.split("\n").length > 15) {
    out.push(`<details><summary>${request.split("\n").length} lines</summary>\n\n${quote(request)}\n\n</details>`);
  } else out.push(quote(request));

  // Gate decisions are kept per project; a session owns the ones made while it was the newest.
  const end = s.ended_at ?? Number.POSITIVE_INFINITY;
  const decisions = (input.gateEvents ?? [])
    .filter((g) => g.created_at >= s.created_at && g.created_at < end)
    .map((g) => ({ g, text: decisionText(g, stages) }))
    .filter((d): d is { g: GateEvent; text: string } => Boolean(d.text));
  if (decisions.length) {
    out.push("## Gate decisions");
    out.push(
      decisions
        .map(({ g, text }) => {
          const feedback = g.feedback ? ` — “${mdInline(clipText(String(g.feedback), 200))}”` : "";
          return `- ${formatTime(g.created_at)} · ${mdInline(text)}${feedback}`;
        })
        .join("\n"),
    );
  }

  out.push("## History");
  if (input.shown < input.total) {
    out.push(`_Only the latest ${input.shown} of ${input.total} stored events are included; earlier ones are not shown._`);
  }
  const blocks = historyBlocks(input.events, stages);
  if (!blocks.length) out.push("_No stored events for this session._");
  else {
    let body = "";
    blocks.forEach((b, i) => {
      if (i) body += b.list && blocks[i - 1].list ? "\n" : "\n\n";
      body += b.md;
    });
    out.push(body);
  }
  return out.join("\n\n") + "\n";
}

interface Block {
  md: string;
  /** A list line: consecutive ones stay one list. */
  list?: boolean;
}

/** Stored events as Markdown blocks. Streamed parts (text, tool) are merged into one each. */
export function historyBlocks(events: NeoEvent[], stages?: StageLabel[]): Block[] {
  const merged = new Map<string, NeoEvent>();
  const order: string[] = [];
  const sorted = [...events].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  for (const ev of sorted) {
    let key: string;
    if ((ev.kind === "text" || ev.kind === "tool" || ev.kind === "error") && ev.part !== undefined && ev.part !== null) {
      key = `${ev.kind}:${String(ev.part)}`;
    } else {
      key = `seq:${String(ev.seq ?? order.length)}:${order.length}`;
    }
    const prev = merged.get(key);
    if (!prev) {
      order.push(key);
      merged.set(key, ev.kind === "text" ? { ...ev, text: textOf(undefined, ev) } : { ...ev });
    } else if (ev.kind === "text") {
      merged.set(key, { ...prev, text: textOf(prev.text as string, ev) });
    } else {
      merged.set(key, { ...prev, ...ev });
    }
  }

  const blocks: Block[] = [];
  for (const key of order) {
    const ev = merged.get(key)!;
    switch (ev.kind) {
      case "user": {
        const note = String(ev.note ?? "");
        const text = String(ev.text ?? "");
        if (KICKOFF_NOTES.has(note)) {
          blocks.push({ md: "_NEO started the session with the request above (its full kickoff prompt is not repeated here)._" });
        } else if (HUMAN_NOTES.has(note)) {
          const cut = text.indexOf(CONTEXT_MARKER);
          const own = cut >= 0 ? text.slice(0, cut) : text;
          const extra = cut >= 0 ? "\n\n_(with context attached from VS Code)_" : "";
          blocks.push({ md: `**${note === "answer" ? "You (answer)" : "You"}:**\n\n${quote(own.trim() || "(empty)")}${extra}` });
        } else {
          blocks.push({ md: `_Automatic message from NEO (${mdInline(note)}):_ ${mdInline(clipText(text.trim(), 160))}` });
        }
        break;
      }
      case "text": {
        const text = String(ev.text ?? "").trim();
        if (text) blocks.push({ md: `**NEO:**\n\n${text}` });
        break;
      }
      case "tool": {
        const status = ev.status === "error" ? " — failed" : ev.status && ev.status !== "completed" ? ` — ${mdInline(ev.status)}` : "";
        const title = ev.title ? ` ${mdInline(ev.title)}` : "";
        blocks.push({ md: `- ${codeSpan(ev.tool || "tool")}${title}${status}`, list: true });
        break;
      }
      case "question": {
        const qs = Array.isArray(ev.questions) ? (ev.questions as { question?: string; options?: string[] }[]) : [];
        const lines = qs.map((q) => {
          const opts = Array.isArray(q.options) && q.options.length ? `\n\n  _Options:_ ${q.options.map(mdInline).join(" · ")}` : "";
          return `${String(q.question ?? "").trim()}${opts}`;
        });
        blocks.push({ md: `**NEO asked:**\n\n${lines.join("\n\n") || "_(a question)_"}` });
        break;
      }
      case "notice":
        blocks.push({ md: noticeNeedsUser(ev) ? `> **Needed you:** ${mdInline(noticeText(ev))}` : `_Note: ${mdInline(noticeText(ev))}_` });
        break;
      case "phase": {
        const p = String(ev.phase ?? "");
        if (p) blocks.push({ md: `### ${p === "done" ? "Done" : mdInline(phaseLabel(p, stages))}` });
        break;
      }
      case "gate": {
        const path = ev.artifact_path ? ` · ${codeSpan(ev.artifact_path)}` : "";
        blocks.push({ md: `**Gate reached:** ${mdInline(ev.title || phaseLabel(ev.phase as string | undefined, stages))}${path}` });
        break;
      }
      case "error": {
        const label = [ev.name, ev.statusCode ? `HTTP ${String(ev.statusCode)}` : ""].filter(Boolean).join(" · ");
        blocks.push({ md: `> **Error${label ? ` (${mdInline(label)})` : ""}:** ${mdInline(clipText(String(ev.message ?? "error"), 400))}` });
        break;
      }
      default:
        break;                                   // status, idle, usage, reasoning: not history
    }
  }
  return blocks;
}

function textOf(prev: string | undefined, ev: NeoEvent): string {
  if (typeof ev.text === "string" && (ev.replace || typeof ev.delta !== "string")) return ev.text;
  return (prev ?? "") + (typeof ev.delta === "string" ? ev.delta : "");
}
