// Sessions, history and resume: the pure rules (src/sessionHistory.ts) and, end to end, the real
// sidebar against a mock NEO (src/sessions.ts wired into ChatViewProvider): the last-seen anchor,
// "since you were away", session boundaries and the read-only session snapshot.
import { MemoryStore, stubState } from "./vscodeStub";
import { MockNeo } from "./mockNeo";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type * as vscode from "vscode";
import { ChatViewProvider } from "../chatViewProvider";
import type { GateEvent, NeoEvent, NeoSession } from "../neoClient";
import {
  AwayInput,
  SeenAnchor,
  anchorKey,
  awaySummary,
  covers,
  describeNow,
  formatTime,
  historyBlocks,
  mdInline,
  sessionMarkdown,
} from "../sessionHistory";
import type { SessionsController, SessionsView } from "../sessions";

// --- the pure rules ------------------------------------------------------------------------

const idle = { phase: "execute", busy: false, atGate: false, awaiting: false, needsAttention: false };

function anchor(seq: number, extra: Partial<SeenAnchor> = {}): SeenAnchor {
  return { seq, session: "s1", gateAt: 0, plan: null, at: 1_700_000_000_000, ...extra };
}

function input(extra: Partial<AwayInput>): AwayInput {
  return {
    trigger: "open",
    anchor: anchor(10),
    events: [],
    complete: true,
    newestSeq: 10,
    sessions: [session("s1")],
    activeSession: "s1",
    gateEvents: [],
    plan: null,
    now: idle,
    ...extra,
  };
}

function session(id: string, extra: Partial<NeoSession> = {}): NeoSession {
  return { id, kind: "full", title: id, request: null, created_at: 1000, ended_at: null, first_event: 1, last_event: 10, ...extra };
}

describe("covers: whether every event since the anchor was read", () => {
  const ev = (seq: number): NeoEvent => ({ kind: "text", seq });
  it("the whole session was read", () => assert.equal(covers(50, [ev(60)], 1, 1), true));
  it("the window reaches back to the anchor", () => assert.equal(covers(50, [ev(50), ev(51)], 900, 200), true));
  it("the window starts after the anchor: a gap", () => assert.equal(covers(50, [ev(70), ev(71)], 900, 200), false));
  it("nothing read of a longer session: a gap", () => assert.equal(covers(50, [], 5, 0), false));
});

describe("awaySummary", () => {
  it("first visit: says there is no record, counts nothing", () => {
    const s = awaySummary(input({ anchor: undefined, newestSeq: 40 }))!;
    assert.equal(s.kind, "first");
    assert.deepEqual(s.items, []);
    assert.match(s.notes[0], /no record of your last visit/);
    assert.equal(s.firstNewSeq, null);
  });

  it("first visit with nothing stored, or not on opening: nothing to say", () => {
    assert.equal(awaySummary(input({ anchor: undefined, newestSeq: 0, sessions: [] })), null);
    assert.equal(awaySummary(input({ anchor: undefined, newestSeq: 40, trigger: "return" })), null);
  });

  it("nothing after the anchor: no card", () => {
    const events: NeoEvent[] = [{ kind: "question", seq: 9 }, { kind: "phase", phase: "plan", seq: 10 }];
    assert.equal(awaySummary(input({ events })), null);
  });

  it("counts only stored events after the anchor, each kind as NEO stored it", () => {
    const events: NeoEvent[] = [
      { kind: "question", seq: 8 },                                     // before the anchor: seen
      { kind: "text", part: "p1", delta: "Hel", seq: 11 },
      { kind: "text", part: "p1", delta: "lo", seq: 12 },               // the same message
      { kind: "phase", phase: "plan", seq: 13 },
      { kind: "phase", phase: "plan-gate", seq: 14 },                   // a gate phase: listed as a gate
      { kind: "gate", phase: "plan-gate", title: "Implementation plan", seq: 15 },
      { kind: "user", text: "go", note: null, seq: 16 },                // typed by a person
      { kind: "user", text: "continue", note: "auto-continue", seq: 17 }, // NEO talking to itself
      { kind: "user", text: "yes", note: "answer", seq: 18 },
      { kind: "phase", phase: "execute", seq: 19 },
      { kind: "tool", part: "t1", tool: "edit", status: "running", seq: 20 },
      { kind: "tool", part: "t1", tool: "edit", status: "completed", seq: 21 },
      { kind: "question", seq: 22 },
      { kind: "notice", stalled: "no progress", seq: 23 },
      { kind: "notice", auto_approved: "design-gate", seq: 24 },       // not one that stops for the user
      { kind: "error", message: "boom", seq: 25 },
      { kind: "usage", seq: 26 },
    ];
    const s = awaySummary(input({ events, newestSeq: 26 }))!;
    assert.equal(s.kind, "activity");
    assert.equal(s.partial, false);
    assert.deepEqual(
      s.items.map((i) => i.text),
      [
        "Moved to Plan → Execute",
        "Reached the gate: Implementation plan",
        "NEO asked 1 question",
        "2 messages sent to NEO",
        "NEO stopped for you: no progress — NEO waited for guidance",
        "1 error reported",
        "NEO wrote 1 message and ran 1 tool action",
      ],
    );
    assert.equal(s.firstNewSeq, 11);
    assert.equal(s.since, 1_700_000_000_000);
    // Stream events carry no time: none is invented for them.
    assert.ok(s.items.every((i) => i.at === undefined));
  });

  it("an incomplete read says so and every count becomes a minimum", () => {
    const events: NeoEvent[] = [{ kind: "question", seq: 500 }, { kind: "question", seq: 501 }, { kind: "error", seq: 502 }];
    const s = awaySummary(input({ events, complete: false, newestSeq: 502 }))!;
    assert.equal(s.partial, true);
    assert.match(s.notes[0], /counts are minimums/);
    assert.ok(s.items.some((i) => i.text === "NEO asked at least 2 questions"));
    assert.ok(s.items.some((i) => i.text === "At least 1 error reported"));
  });

  it("history that ends before the anchor (a reset NEO) is said, not compared", () => {
    const s = awaySummary(input({ anchor: anchor(900), newestSeq: 40, events: [{ kind: "question", seq: 40 }] }))!;
    assert.equal(s.kind, "mismatch");
    assert.deepEqual(s.items, []);
    assert.match(s.notes[0], /reset or restored/);
  });

  it("session changes: the one seen ended, a new one started, with NEO's own times", () => {
    const sessions = [
      session("s1", { title: "Build", ended_at: 5000, last_event: 30 }),
      session("s2", { title: "Fix login", kind: "quick", created_at: 5000, first_event: 31, last_event: 40 }),
    ];
    const s = awaySummary(input({ sessions, activeSession: "s2", events: [{ kind: "text", part: "x", seq: 35 }], newestSeq: 40 }))!;
    assert.deepEqual(s.items.slice(0, 2), [
      { text: "Session “Build” ended", at: 5000 },
      { text: "New session started: “Fix login” (Quick change)", at: 5000 },
    ]);
    // The old session's activity after the anchor is not in the loaded history: pointed at, not counted.
    assert.ok(s.notes.some((n) => /“Build” had more activity/.test(n)));
  });

  it("the session last seen is gone from NEO's records: said", () => {
    const s = awaySummary(input({ anchor: anchor(10, { session: "gone" }), events: [{ kind: "question", seq: 11 }], newestSeq: 11 }))!;
    assert.ok(s.notes.includes("The session you last saw is no longer in NEO's records."));
  });

  it("gate decisions after the last one seen, with the time NEO recorded; audit rows that are not decisions are left out", () => {
    const gateEvents: GateEvent[] = [
      { phase: "design-gate", action: "approved", created_at: 100 },     // seen
      { phase: "plan-gate", action: "detected", created_at: 300 },       // not a decision
      { phase: "plan-gate", action: "rejected", created_at: 310, feedback: "smaller tasks" },
      { phase: "plan-gate", action: "auto-approved", created_at: 400 },
    ];
    const s = awaySummary(input({ anchor: anchor(10, { gateAt: 100 }), gateEvents }))!;
    assert.deepEqual(s.items, [
      { text: "Plan gate: changes requested", at: 310 },
      { text: "Plan gate: approved automatically (every check passed)", at: 400 },
    ]);
  });

  it("plan progress: the ticked-step delta, only for the same plan", () => {
    const moved = awaySummary(input({ anchor: anchor(10, { plan: { done: 3, total: 10 } }), plan: { done: 7, total: 10 } }))!;
    assert.deepEqual(moved.items.map((i) => i.text), ["Plan: 3 → 7 of 10 steps ticked"]);
    const replanned = awaySummary(input({ anchor: anchor(10, { plan: { done: 3, total: 10 } }), plan: { done: 0, total: 6 } }))!;
    assert.deepEqual(replanned.items.map((i) => i.text), ["Plan progress is now 0 of 6 steps (was 3 of 10)"]);
    assert.equal(awaySummary(input({ anchor: anchor(10, { plan: null }), plan: { done: 7, total: 10 } })), null);
  });

  it("a gate reached again after changes were requested is one line with a count", () => {
    const events: NeoEvent[] = [
      { kind: "gate", phase: "review-gate", title: "Code review", seq: 11 },
      { kind: "gate", phase: "review-gate", title: "Code review", seq: 12 },
    ];
    const s = awaySummary(input({ events, newestSeq: 12 }))!;
    assert.deepEqual(s.items.map((i) => i.text), ["Reached the gate: Code review (2 times)"]);
  });

  it("coming back to an open window: only a change of picture makes a card", () => {
    const chatter: NeoEvent[] = [{ kind: "text", part: "a", seq: 11 }, { kind: "tool", part: "b", seq: 12 }];
    assert.equal(awaySummary(input({ trigger: "return", events: chatter, newestSeq: 12 })), null);
    const gate: NeoEvent[] = [...chatter, { kind: "gate", phase: "review-gate", title: "Review", seq: 13 }];
    assert.ok(awaySummary(input({ trigger: "return", events: gate, newestSeq: 13 })));
  });

  it("where things stand now, from the state the sidebar already holds", () => {
    assert.equal(describeNow({ ...idle, atGate: true, phase: "review-gate", gate: { title: "Review" } }), "Waiting for your decision at the gate: Review");
    assert.equal(describeNow({ ...idle, awaiting: true }), "Waiting for your answer to NEO's question");
    assert.equal(describeNow({ ...idle, needsAttention: true, attentionReason: "stalled" }), "Waiting on you: stalled");
    assert.equal(describeNow({ ...idle, busy: true }), "NEO is working · Execute");
    assert.equal(describeNow({ ...idle, phase: "done" }), "Finished · nothing is running");
    assert.match(describeNow(idle)!, /^Nothing is running · Execute/);
    assert.equal(describeNow({ ...idle, phase: undefined }), null);
  });
});

describe("the read-only session document", () => {
  const s = session("s1", {
    title: "Fix *login*",
    kind: "quick",
    request: "Users cannot log in\nwith an email in caps",
    created_at: 1_700_000_000,
    ended_at: 1_700_003_600,
    messages: 4,
  });
  const doc = () =>
    sessionMarkdown({
      projectName: "MiniBank",
      session: s,
      index: 1,
      count: 2,
      active: false,
      events: [
        { kind: "user", note: "new session", text: "Here is what I want changed: ...", seq: 1 },
        { kind: "text", part: "p", delta: "Look", seq: 2 },
        { kind: "text", part: "p", delta: "ing", seq: 3 },
        { kind: "tool", part: "t", tool: "edit", title: "app/auth.py", status: "completed", seq: 4 },
        { kind: "tool", part: "u", tool: "bash", title: "pytest", status: "error", seq: 5 },
        { kind: "user", note: "auto-continue", text: "Continue with the next task", seq: 6 },
        { kind: "user", note: null, text: `Also lowercase\n\n--- Attached from VS Code ---\nsecret file`, seq: 7 },
        { kind: "gate", phase: "review-gate", title: "Review", artifact_path: "docs/neoag/review.md", seq: 8 },
        { kind: "status", busy: false, seq: 9 },
      ],
      total: 40,
      shown: 9,
      gateEvents: [
        { phase: "review-gate", action: "rejected", created_at: 1_700_001_000, feedback: "add a test" },
        { phase: "review-gate", action: "approved", created_at: 1_700_009_999 },   // after this session ended
      ],
      takenAt: 1_700_010_000,
    });

  it("states that it is a read-only snapshot and names the session", () => {
    const md = doc();
    assert.match(md, /^# Fix \\\*login\\\*\n/);
    assert.match(md, /\*\*Read-only snapshot\*\*/);
    assert.match(md, /does not change the active session, restart any work, or modify the project/);
    assert.match(md, /\| Session \| 1 of 2 \|/);
    assert.match(md, /\| Type \| Quick change \|/);
    assert.match(md, /\| Status \| Ended \|/);
    assert.ok(md.includes(`| Started | ${formatTime(1_700_000_000)} |`));
    assert.ok(md.includes(`| Ended | ${formatTime(1_700_003_600)} |`));
    assert.match(md, /> Users cannot log in\n> with an email in caps/);
  });

  it("includes only this session's gate decisions, and says when history is truncated", () => {
    const md = doc();
    assert.ok(md.includes(`- ${formatTime(1_700_001_000)} · Review gate: changes requested — “add a test”`));
    assert.ok(!md.includes("Review gate: approved"));
    assert.match(md, /Only the latest 9 of 40 stored events are included/);
  });

  it("merges streamed parts, keeps NEO's own messages apart, and leaves attached context out", () => {
    const md = doc();
    assert.match(md, /\*\*NEO:\*\*\n\nLooking/);
    assert.match(md, /- `edit` app\/auth\.py\n- `bash` pytest — failed/);
    assert.match(md, /_Automatic message from NEO \(auto-continue\):_ Continue with the next task/);
    assert.match(md, /\*\*You:\*\*\n\n> Also lowercase\n\n_\(with context attached from VS Code\)_/);
    assert.ok(!md.includes("secret file"));
    assert.match(md, /_NEO started the session with the request above/);
    assert.ok(!md.includes("Here is what I want changed"));
    assert.match(md, /\*\*Gate reached:\*\* Review · `docs\/neoag\/review.md`/);
  });

  it("the active session says so", () => {
    const md = sessionMarkdown({ projectName: "p", session: session("s9"), index: 2, count: 2, active: true, events: [], total: 0, shown: 0, takenAt: 1 });
    assert.match(md, /\| Status \| \*\*Active\*\* · the session the NEO sidebar follows \|/);
    assert.match(md, /\| Ended \| — \(still active\) \|/);
    assert.match(md, /_No stored events for this session._/);
  });

  it("escapes inline markup and keeps blocks apart", () => {
    assert.equal(mdInline("a*b_[c]<d>|#`"), "a\\*b\\_\\[c\\]\\<d\\>\\|\\#\\`");
    assert.equal(historyBlocks([{ kind: "usage", seq: 1 }, { kind: "idle", seq: 2 }]).length, 0);
  });
});

// --- the sidebar, end to end ------------------------------------------------------------------

interface SessionsState {
  mode: string;
  project?: { id: string };
  sessions?: SessionsView;
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) {
    try {
      await f();
    } catch {
      // A temp folder left behind is harmless.
    }
  }
});

async function until(pred: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A mock NEO with one project in its own folder, two sessions, and a sidebar not yet opened. */
async function setup(opts: { visible?: boolean; store?: MemoryStore; build?: (neo: MockNeo, id: string) => void } = {}) {
  const neo = new MockNeo();
  stubState.serverUrl = await neo.listen();
  cleanup.push(() => neo.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neo-sessions-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const id = "p1";
  neo.add({ id, path: root, name: "MiniBank", busy: false, phase: "execute" });
  if (opts.build) opts.build(neo, id);
  else {
    neo.startSession(id, { id: "s1", title: "Build", created_at: 1000 });
    neo.record(id, { kind: "user", note: "kickoff", text: "Build it" });
    neo.record(id, { kind: "text", part: "a", text: "Done building", replace: true });
    neo.startSession(id, { id: "s2", kind: "quick", title: "Fix login", request: "Fix login", created_at: 2000 });
    neo.record(id, { kind: "user", note: "new session", text: "Here is what I want changed" });
    neo.record(id, { kind: "phase", phase: "execute" });
  }
  stubState.folders = [root];
  stubState.quickPick = null;
  stubState.commands = [];
  stubState.focused = true;

  const store = opts.store ?? new MemoryStore();
  const vs = require("vscode") as { Uri: { file(p: string): vscode.Uri } };
  const provider = new ChatViewProvider(vs.Uri.file(path.resolve(__dirname, "..", "..")), store as unknown as vscode.Memento);
  cleanup.push(() => provider.dispose());
  const posted: { type: string; state?: SessionsState }[] = [];
  let visibility: () => void = () => {};
  const view = {
    visible: opts.visible ?? true,
    webview: {
      options: {}, html: "", cspSource: "vscode-resource:", asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (m: { type: string }) => { posted.push(JSON.parse(JSON.stringify(m))); return true; },
    },
    onDidDispose: () => ({ dispose() {} }),
    onDidChangeVisibility: (cb: () => void) => { visibility = cb; return { dispose() {} }; },
  };
  provider.resolveWebviewView(view as unknown as vscode.WebviewView);
  const state = () => [...posted].reverse().find((m) => m.type === "state")?.state;
  const sessions = () => state()?.sessions;
  const controller = (provider as unknown as { sessions: SessionsController }).sessions;
  const key = anchorKey(new URL(stubState.serverUrl).host, id);
  const show = (visible: boolean) => {
    view.visible = visible;
    visibility();
  };
  return { neo, id, provider, store, state, sessions, controller, key, show, posted };
}

const lastSeqOf = (neo: MockNeo, id: string) => {
  const h = neo.projects.get(id)!.history;
  return h[h.length - 1].seq as number;
};

describe("sessions in the sidebar", () => {
  it("names the active session and lists the earlier one, from NEO's records", async () => {
    const t = await setup();
    await t.provider.connect();
    await until(() => Boolean(t.sessions()?.active), "the session view");
    const v = t.sessions()!;
    assert.equal(v.supported, true);
    assert.equal(v.active!.id, "s2");
    assert.equal(v.active!.kind, "Quick change");
    assert.deepEqual(v.list.map((r) => [r.id, r.index, r.count, r.active, r.endedAt]), [["s1", 1, 2, false, 2000], ["s2", 2, 2, true, null]]);
    // Only the active session's history is loaded into the chat, as NEO serves it.
    assert.equal(v.hiddenEarlier, 0);
  });

  it("follows a new session NEO starts while the sidebar is open", async () => {
    const t = await setup();
    await t.provider.connect();
    await until(() => t.sessions()?.active?.id === "s2", "s2 active");
    t.neo.startSession(t.id, { id: "s3", title: "Add export", created_at: 3000 });
    t.neo.emit(t.id, { kind: "phase", phase: "brainstorm" });
    await (t.provider as unknown as { resync(): Promise<void> }).resync();
    await until(() => t.sessions()?.active?.id === "s3", "s3 active");
    const s3 = t.sessions()!.list.find((r) => r.id === "s3")!;
    assert.equal(typeof s3.firstEvent, "number");
    assert.equal(t.sessions()!.list.find((r) => r.id === "s2")!.active, false);
  });

  it("a NEO without sessions: the feature steps aside", async () => {
    const t = await setup({ build: (neo, id) => void neo.record(id, { kind: "phase", phase: "execute" }) });
    await t.provider.connect();
    await until(() => t.state()?.mode === "project", "project");
    assert.equal(t.sessions()!.supported, false);
    assert.equal(t.sessions()!.active, null);
  });
});

describe("since you were away", () => {
  it("first visit: says there is no record, then remembers what is on screen", async () => {
    const t = await setup();
    await t.provider.connect();
    await until(() => Boolean(t.sessions()?.away), "the card");
    assert.equal(t.sessions()!.away!.kind, "first");
    await until(() => t.store.get<SeenAnchor>(t.key)?.seq === lastSeqOf(t.neo, t.id), "the anchor written");
    assert.equal(t.store.get<SeenAnchor>(t.key)!.session, "s2");
  });

  it("reopening: summarises what NEO stored after the last event seen, then marks it seen", async () => {
    const store = new MemoryStore();
    const first = await setup({ store });
    await first.provider.connect();
    await until(() => first.store.get<SeenAnchor>(first.key)?.seq === lastSeqOf(first.neo, first.id), "first anchor");
    const seenSeq = first.store.get<SeenAnchor>(first.key)!.seq;
    first.provider.dispose();
    const seenAt = store.get<SeenAnchor>(first.key)!.at;

    // While VS Code was closed.
    first.neo.record(first.id, { kind: "question", questions: [{ question: "Which DB?" }] });
    first.neo.record(first.id, { kind: "gate", phase: "review-gate", title: "Review" });
    first.neo.projects.get(first.id)!.gate_events = [{ phase: "review-gate", action: "detected", created_at: 9999 }];

    // Reopen against the same NEO and the same globalState.
    const vs = require("vscode") as { Uri: { file(p: string): vscode.Uri } };
    const provider = new ChatViewProvider(vs.Uri.file(path.resolve(__dirname, "..", "..")), store as unknown as vscode.Memento);
    cleanup.push(() => provider.dispose());
    const posted: { type: string; state?: SessionsState }[] = [];
    provider.resolveWebviewView({
      visible: true,
      webview: {
        options: {}, html: "", cspSource: "", asWebviewUri: (u: unknown) => u,
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async (m: { type: string }) => { posted.push(JSON.parse(JSON.stringify(m))); return true; },
      },
      onDidDispose: () => ({ dispose() {} }),
      onDidChangeVisibility: () => ({ dispose() {} }),
    } as unknown as vscode.WebviewView);
    await provider.connect();
    const away = () => [...posted].reverse().find((m) => m.type === "state")?.state?.sessions?.away;
    await until(() => Boolean(away()), "the summary");
    const a = away()!;
    assert.equal(a.kind, "activity");
    assert.deepEqual(a.items.map((i) => i.text), ["Reached the gate: Review", "NEO asked 1 question"]);
    assert.equal(a.firstNewSeq, seenSeq + 1);
    assert.equal(a.since, seenAt, "the visit this machine recorded");
    await until(() => store.get<SeenAnchor>(first.key)!.seq === lastSeqOf(first.neo, first.id), "anchor advanced");
    // The divider goes where the new events start.
    const v = [...posted].reverse().find((m) => m.type === "state")!.state!.sessions!;
    assert.equal(v.newFrom, seenSeq + 1);
  });

  it("a hidden sidebar marks nothing seen; showing it does, after summarising", async () => {
    const store = new MemoryStore();
    const t = await setup({ store, visible: false });
    // A visit recorded earlier, before the last two events.
    const seq = lastSeqOf(t.neo, t.id);
    await store.update(t.key, anchor(seq - 1, { session: "s2", at: 42 }));
    await t.provider.connect();
    await until(() => t.state()?.mode === "project", "project open");
    t.neo.emit(t.id, { kind: "question", questions: [{ question: "?" }] });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(store.get<SeenAnchor>(t.key)!.seq, seq - 1, "nothing seen while hidden");
    assert.equal(t.sessions()!.away, null);

    t.show(true);
    await until(() => Boolean(t.sessions()?.away), "the summary");
    assert.ok(t.sessions()!.away!.items.some((i) => i.text === "NEO asked 1 question"));
    await until(() => store.get<SeenAnchor>(t.key)!.seq === lastSeqOf(t.neo, t.id), "anchor advanced");
  });

  it("an unfocused window marks nothing seen", async () => {
    const store = new MemoryStore();
    const t = await setup({ store });
    await store.update(t.key, anchor(lastSeqOf(t.neo, t.id), { session: "s2", at: 42 }));
    stubState.focused = false;
    await t.provider.connect();
    await until(() => t.state()?.mode === "project", "project open");
    t.neo.emit(t.id, { kind: "gate", phase: "review-gate", title: "Review" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(store.get<SeenAnchor>(t.key)!.seq, lastSeqOf(t.neo, t.id) - 1);
    stubState.focused = true;
    t.show(true);
    await until(() => Boolean(t.sessions()?.away), "the summary on return");
    assert.ok(t.sessions()!.away!.items.some((i) => i.text === "Reached the gate: Review"));
  });

  it("a long absence: reads further back before summarising; beyond NEO's cap the counts are minimums", async () => {
    const store = new MemoryStore();
    const t = await setup({ store });
    const seen = lastSeqOf(t.neo, t.id);
    await store.update(t.key, anchor(seen, { session: "s2", at: 42 }));
    for (let i = 0; i < 2100; i++) t.neo.record(t.id, { kind: "question", questions: [] });
    // The wider read is held: until it answers, nothing may be summarised or marked seen.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    t.neo.holdRead = (history) => (history === 2000 ? held : undefined);
    await t.provider.connect();
    await until(() => t.neo.calls.some((c) => c.includes("history=2000")), "the gap read");
    await new Promise((r) => setTimeout(r, 200));
    (t.provider as unknown as { postState(): void }).postState();
    assert.equal(store.get<SeenAnchor>(t.key)!.seq, seen, "not marked seen while the gap is being read");
    assert.equal(t.sessions()!.away, null, "no summary from half the events");
    release();
    await until(() => Boolean(t.sessions()?.away), "the summary");
    const a = t.sessions()!.away!;
    assert.equal(a.partial, true);
    assert.ok(a.items.some((i) => i.text === "NEO asked at least 2000 questions"));
    await until(() => store.get<SeenAnchor>(t.key)!.seq === lastSeqOf(t.neo, t.id), "anchor advanced");
  });

  it("a gap the wider read covers is exact", async () => {
    const store = new MemoryStore();
    const t = await setup({ store });
    await store.update(t.key, anchor(lastSeqOf(t.neo, t.id), { session: "s2", at: 42 }));
    for (let i = 0; i < 250; i++) t.neo.record(t.id, { kind: "question", questions: [] });
    await t.provider.connect();
    await until(() => Boolean(t.sessions()?.away), "the summary");
    const a = t.sessions()!.away!;
    assert.equal(a.partial, false);
    assert.ok(a.items.some((i) => i.text === "NEO asked 250 questions"));
  });

  it("a session NEO started while away is named, and the earlier one's end", async () => {
    const store = new MemoryStore();
    const t = await setup({ store });
    await store.update(t.key, anchor(lastSeqOf(t.neo, t.id), { session: "s2", at: 42 }));
    t.neo.startSession(t.id, { id: "s3", kind: "prd", title: "Add export", created_at: 3000 });
    t.neo.record(t.id, { kind: "user", note: "new session", text: "x" });
    t.neo.record(t.id, { kind: "phase", phase: "plan" });
    await t.provider.connect();
    await until(() => Boolean(t.sessions()?.away), "the summary");
    const texts = t.sessions()!.away!.items.map((i) => i.text);
    assert.equal(texts[0], "Session “Fix login” ended");
    assert.equal(texts[1], "New session started: “Add export” (Quick plan)");
    assert.equal(t.sessions()!.away!.items[1].at, 3000);
  });

  it("events replayed by a reconnect are counted once", async () => {
    const store = new MemoryStore();
    const t = await setup({ store, visible: false });
    await store.update(t.key, anchor(lastSeqOf(t.neo, t.id), { session: "s2", at: 42 }));
    await t.provider.connect();
    await until(() => t.neo.open(t.id) === 1, "stream open");
    t.neo.emit(t.id, { kind: "question", questions: [] });
    await new Promise((r) => setTimeout(r, 150));
    t.neo.drop(t.id);                                   // the catch-up re-reads the same events
    await until(() => t.neo.open(t.id) === 1, "reconnected", 8000);
    await new Promise((r) => setTimeout(r, 300));
    t.show(true);
    await until(() => Boolean(t.sessions()?.away), "the summary");
    assert.ok(t.sessions()!.away!.items.some((i) => i.text === "NEO asked 1 question"));
  });

  it("dismissing the card keeps the anchor and the divider", async () => {
    const store = new MemoryStore();
    const t = await setup({ store });
    await store.update(t.key, anchor(lastSeqOf(t.neo, t.id) - 1, { session: "s2", at: 42 }));
    await t.provider.connect();
    await until(() => Boolean(t.sessions()?.away), "the summary");
    await t.controller.onMessage({ type: "sessions.dismiss" });
    assert.equal(t.sessions()!.away, null);
    assert.notEqual(t.sessions()!.newFrom, null);
  });

  it("switching project: the card and divider go, each project keeps its own anchor", async () => {
    const store = new MemoryStore();
    const t = await setup({ store });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "neo-sessions-"));
    cleanup.push(() => fs.rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    t.neo.add({ id: "p2", path: other, name: "Other", busy: false });
    t.neo.startSession("p2", { id: "q1", title: "Other build", created_at: 500 });
    t.neo.record("p2", { kind: "phase", phase: "plan" });
    await store.update(t.key, anchor(lastSeqOf(t.neo, t.id) - 1, { session: "s2", at: 42 }));
    await t.provider.connect();
    await until(() => Boolean(t.sessions()?.away), "p1's summary");
    await until(() => store.get<SeenAnchor>(t.key)!.seq === lastSeqOf(t.neo, t.id), "p1 seen");
    const p1Anchor = store.get<SeenAnchor>(t.key);

    stubState.quickPick = (items) => items.find((i) => i.id === "p2");
    await t.provider.switchProject();
    await until(() => t.state()?.project?.id === "p2" && t.sessions()?.active?.id === "q1", "p2 open");
    assert.equal(t.sessions()!.away!.kind, "first", "p1's summary does not carry over");
    assert.equal(t.sessions()!.newFrom, null);
    const p2Key = anchorKey(new URL(stubState.serverUrl).host, "p2");
    await until(() => store.get<SeenAnchor>(p2Key)?.seq === lastSeqOf(t.neo, "p2"), "p2 seen");
    // p1 keeps what was seen of it; leaving it only records when it was last on screen.
    const after = store.get<SeenAnchor>(t.key)!;
    assert.deepEqual({ ...after, at: 0 }, { ...p1Anchor!, at: 0 }, "p1's anchor is not moved by p2");
    assert.ok(after.at >= p1Anchor!.at);
  });
});

describe("inspecting a session is read-only", () => {
  it("the QuickPick lists sessions newest first and opens the picked one as a snapshot", async () => {
    const t = await setup();
    await t.provider.connect();
    await until(() => Boolean(t.sessions()?.active), "sessions");
    let offered: { id?: string; label?: string; description?: string }[] = [];
    stubState.quickPick = (items) => {
      offered = items as typeof offered;
      return items.find((i) => i.id === "s1");
    };
    await t.provider.showSessions();
    assert.deepEqual(offered.map((i) => i.id), ["s2", "s1"]);
    assert.match(offered[0].label!, /^\$\(circle-filled\) Fix login/);
    assert.match(offered[0].description!, /2 of 2 · Quick change · active/);
    assert.match(offered[1].description!, /1 of 2 · Full pipeline · ended/);
    const open = stubState.commands.find((c) => c.id === "markdown.showPreview")!;
    const uri = open.args[0] as vscode.Uri;
    assert.equal(uri.scheme, "neo-session");
    assert.equal(new URLSearchParams(uri.query).get("session"), "s1");
  });

  it("reading an old session changes nothing: no writes, same active session, same stream, same transcript", async () => {
    const t = await setup();
    await t.provider.connect();
    await until(() => t.neo.open(t.id) === 1 && Boolean(t.sessions()?.active), "open");
    const before = {
      active: t.sessions()!.active!.id,
      lastSeq: (t.provider as unknown as { lastSeq: number }).lastSeq,
      histories: t.posted.filter((m) => m.type === "history").length,
      calls: t.neo.calls.length,
    };
    const uri = { query: new URLSearchParams({ project: t.id, session: "s1" }).toString() } as vscode.Uri;
    const md = await t.controller.document(uri);
    assert.match(md, /^# Build\n/);
    assert.match(md, /\| Status \| Ended \|/);
    assert.match(md, /Done building/);
    assert.ok(!md.includes("Here is what I want changed"), "only s1's events");

    const during = t.neo.calls.slice(before.calls);
    assert.ok(during.length > 0 && during.every((c) => c.startsWith("GET ")), `only reads: ${during.join(", ")}`);
    assert.ok(during.some((c) => c.includes("session=s1")));
    await (t.provider as unknown as { resync(): Promise<void> }).resync();
    assert.equal(t.sessions()!.active!.id, before.active);
    assert.equal(t.neo.projects.get(t.id)!.sessions!.length, 2);
    assert.equal((t.provider as unknown as { lastSeq: number }).lastSeq, before.lastSeq);
    assert.equal(t.posted.filter((m) => m.type === "history").length, before.histories, "the transcript was not reloaded");
    assert.equal(t.neo.open(t.id), 1, "the stream was not touched");
  });

  it("an unknown session or an unreachable NEO reads as unavailable, not as an error thrown", async () => {
    const t = await setup();
    await t.provider.connect();
    await until(() => t.state()?.mode === "project", "project");
    const missing = await t.controller.document({ query: `project=${t.id}&session=nope` } as vscode.Uri);
    assert.match(missing, /^# Session unavailable/);
    const blank = await t.controller.document({ query: "" } as vscode.Uri);
    assert.match(blank, /does not name a NEO project and session/);
  });
});
