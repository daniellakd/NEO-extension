// The live panel's state: notices NEO sends, and the one picture buildLive makes of everything.
import "./vscodeStub";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { LiveInput, buildLive, liveNotice, noticeOf, stopExplains } from "../progress";

/** A connected project; each test changes only what it is about. */
const state = (over: Partial<LiveInput> = {}): LiveInput => ({
  connection: "connected", mode: "project", phase: "execute", busy: false, atGate: false, awaiting: false, stopping: false,
  needsAttention: false, attentionReason: null, planProgress: { done: 2, total: 5 }, stream: "up", catchingUp: false, ...over,
});
const live = (over: Partial<LiveInput> = {}, note: Parameters<typeof buildLive>[3] = null, action: string | null = null) =>
  buildLive(state(over), { unit: "task", index: 2, total: 3, title: "Storage", tasksDone: 1 }, action, note);

describe("noticeOf - the notices that describe a state the user is in", () => {
  it("stalled, timeout and runaway: a warning that stays until NEO moves", () => {
    for (const [ev, text] of [
      [{ kind: "notice", stalled: "the turn ended in execute without a phase signal" }, /stalled in the turn ended in execute/],
      [{ kind: "notice", timeout: 1800 }, /No activity for 1800s - the turn was stopped/],
      [{ kind: "notice", runaway: true }, /Runaway output - the turn was stopped/],
      [{ kind: "notice", repair_stuck: "review-gate" }, /Automatic repair stopped on review-gate/],
      [{ kind: "notice", held: "review-gate", failed: "tests red" }, /review-gate is held for you: tests red/],
    ] as const) {
      const n = noticeOf(ev);
      assert.equal(n?.tone, "warn");
      assert.equal(n?.sticky, true);
      assert.match(n!.text, text);
    }
  });

  it("interrupted by a restart and resumed: information, not a warning", () => {
    const n = noticeOf({ kind: "notice", resumed: "execute", attempt: 1, limit: 3 });
    assert.equal(n?.tone, "info");
    assert.equal(n?.text, "A turn in execute was interrupted by a restart - NEO resumed it");
  });

  it("incomplete: continuing is information, a spent budget is a warning", () => {
    assert.equal(noticeOf({ kind: "notice", incomplete: "execution-complete", count: 3, attempt: 1, limit: 3 })?.tone, "info");
    assert.equal(noticeOf({ kind: "notice", incomplete: "execution-complete", count: 3, exhausted: true })?.tone, "warn");
  });

  it("history-only notices (continued, task_done, guard, …) are not a live state", () => {
    for (const ev of [{ continued: 1, limit: 3 }, { task_done: true }, { guard: "x", undone: 1 }, { unearned: "x" }]) {
      assert.equal(noticeOf({ kind: "notice", ...ev }), null);
    }
  });
});

describe("liveNotice - when a held notice is over", () => {
  it("a warning disappears once NEO is busy again; information ages out", () => {
    const warn = noticeOf({ kind: "notice", stalled: "x" });
    assert.ok(liveNotice(warn, false));
    assert.equal(liveNotice(warn, true), null);
    const info = { ...noticeOf({ kind: "notice", resumed: "execute" })!, at: Date.now() - 60_000 };
    assert.equal(liveNotice(info, true), null);
  });
});

describe("buildLive - stale attention", () => {
  const stall = { needsAttention: true, attentionReason: "the turn ended in execute without a phase signal" };

  it("a stall while idle: 'Waiting on you', once", () => {
    const l = live(stall);
    assert.equal(l.activity, "attention");
    assert.equal(l.note?.text, "Waiting on you: the turn ended in execute without a phase signal");
  });

  it("NEO working again: the old 'Waiting on you' is not shown", () => {
    const l = live({ ...stall, busy: true }, null, "Running tests");
    assert.equal(l.activity, "working");
    assert.equal(l.note, null);
    assert.equal(l.action, "Running tests");
  });

  it("a resumed notice is no longer masked by an old stall", () => {
    const resumed = { tone: "info" as const, text: "A turn in execute was interrupted by a restart - NEO resumed it" };
    assert.equal(live({ ...stall, busy: true }, resumed).note?.text, resumed.text);
  });

  it("a question is waiting for the user, not a stall", () => {
    const l = live({ needsAttention: true, attentionReason: "the agent asked a question", awaiting: true, busy: true });
    assert.equal(l.activity, "awaiting");
    assert.equal(l.note, null);
    assert.equal(l.canStop, false);
  });
});

describe("buildLive - Stop", () => {
  const errorStall = { needsAttention: true, attentionReason: "the turn in execute ended with an error" };

  it("working: Stop offered; stopping: not offered twice", () => {
    assert.equal(live({ busy: true }).canStop, true);
    const l = live({ busy: true, stopping: true });
    assert.equal(l.activity, "stopping");
    assert.equal(l.canStop, false);
  });

  it("just stopped: 'stopped' with a calm note", () => {
    const l = live({ stoppedAt: Date.now() });
    assert.equal(l.activity, "stopped");
    assert.match(l.note!.text, /Turn stopped - nothing was undone/);
  });

  it("the 'ended with an error' NEO reports for the stopped turn is said as the Stop", () => {
    const l = live({ ...errorStall, userStopped: true, stoppedAt: Date.now() - 60_000 });
    assert.equal(l.activity, "stopped");
    assert.match(l.note!.text, /Turn stopped/);
  });

  it("the same reason without a user Stop is a real failure", () => {
    const l = live(errorStall);
    assert.equal(l.activity, "attention");
    assert.equal(l.note?.text, "Waiting on you: the turn in execute ended with an error");
  });

  it("any other reason after a Stop is still a real problem", () => {
    const l = live({ needsAttention: true, attentionReason: "the turn ended in execute without a phase signal", userStopped: true });
    assert.equal(l.activity, "attention");
  });

  it("only that exact reason is explained by a Stop", () => {
    assert.equal(stopExplains("the turn in execute ended with an error"), true);
    assert.equal(stopExplains("the turn in plan ended with an error"), true);
    assert.equal(stopExplains("the turn ended in execute without a phase signal"), false);
    assert.equal(stopExplains(undefined), false);
  });

  it("not offered while waiting for an answer or a gate, idle or done", () => {
    assert.equal(live({ busy: true, awaiting: true }).canStop, false);
    assert.equal(live({ busy: true, atGate: true }).canStop, false);
    assert.equal(live({ busy: false }).canStop, false);
    assert.equal(live({ busy: true, phase: "done" }).canStop, false);
  });
});

describe("buildLive - connection and phases", () => {
  it("offline: nothing about the plan, said plainly", () => {
    const l = live({ connection: "unreachable" });
    assert.equal(l.activity, "offline");
    assert.equal(l.progress, null);
  });

  it("the stream reconnecting is passed on with its retry time", () => {
    const l = live({ stream: "reconnecting", streamRetryAt: 123 });
    assert.deepEqual(l.stream, { state: "reconnecting", retryAt: 123, catchingUp: false });
  });

  it("plan rows from Execute through Finish and Done, not before", () => {
    for (const phase of ["execute", "review", "review-gate", "finish", "done"]) assert.ok(live({ phase }).progress, phase);
    assert.equal(live({ phase: "plan-gate", planProgress: { done: 0, total: 5 } }).progress, null);
  });

  it("once Execute is over no task is presented as current; a finished plan says so", () => {
    const open = { unit: "task" as const, index: 3, total: 3, title: "Docs", tasksDone: 2, complete: false };
    const done = { unit: "step" as const, index: 6, total: 6, complete: true };
    assert.deepEqual(buildLive(state({ phase: "execute" }), open, null, null).task, open, "Execute: the task being worked on");
    for (const phase of ["review", "review-gate", "finish", "done"]) {
      const unfinished = buildLive(state({ phase, planProgress: { done: 5, total: 6 } }), open, null, null);
      assert.equal(unfinished.task, null, `${phase}: no old task as the current one`);
      assert.deepEqual(unfinished.progress, { done: 5, total: 6 }, `${phase}: the count stays`);
      assert.deepEqual(buildLive(state({ phase, planProgress: { done: 6, total: 6 } }), done, null, null).task, done, `${phase}: "All 6 tasks done"`);
    }
  });
});
