import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ProgressRecord, planKey, reconcile, staleAfter, stageOf } from "../progressMemory";

const plan = { key: "tasks:A\u0001B|steps:0,0,1", steps: 3 };
const record = (done: number, extra: Partial<ProgressRecord> = {}): ProgressRecord => ({ plan: plan.key, done, total: 3, seq: 100, ...extra });

describe("stageOf - NEO's phases", () => {
  it("knows planning, Execute and what follows it", () => {
    for (const p of ["setup", "analysis", "analysis-gate", "brainstorm", "design-gate", "plan", "plan-gate"]) assert.equal(stageOf(p), "before", p);
    assert.equal(stageOf("execute"), "execute");
    for (const p of ["review", "review-gate", "finish", "done"]) assert.equal(stageOf(p), "after", p);
    assert.equal(stageOf("something-new"), undefined);
    assert.equal(stageOf(undefined), undefined);
  });
});

describe("planKey - a plan's identity for progress", () => {
  it("is its tasks and their steps, not the ticks", () => {
    const outline = { tasks: ["A", "B"], stepTask: [0, 0, 1] };
    assert.equal(planKey(outline, []), planKey({ tasks: ["A", "B"], stepTask: [0, 0, 1] }, []));
    assert.notEqual(planKey(outline, []), planKey({ tasks: ["A", "B"], stepTask: [0, 1, 1] }, []));
    assert.notEqual(planKey(outline, []), planKey({ tasks: ["A", "C"], stepTask: [0, 0, 1] }, []));
  });

  it("falls back to checklist titles, and is undefined when nothing is known", () => {
    assert.equal(planKey(undefined, ["x", "y"]), "items:x\u0001y");
    assert.equal(planKey(undefined, []), undefined);
  });
});

describe("reconcile - NEO's count, or the remembered one", () => {
  it("Execute: NEO's count is shown and recorded, even when it is lower", () => {
    const r = reconcile({ backend: { done: 1, total: 3 }, phase: "execute", plan, seq: 200, record: record(3) });
    assert.deepEqual(r.progress, { done: 1, total: 3 });
    assert.equal(r.restored, false);
    assert.deepEqual(r.record, { plan: plan.key, done: 1, total: 3, ticks: undefined, seq: 200 });
  });

  it("records the ticks only when they add up to NEO's count", () => {
    const good = reconcile({ backend: { done: 2, total: 3 }, phase: "execute", plan, ticks: [true, false, true], seq: 1, record: undefined });
    assert.deepEqual(good.record?.ticks, [true, false, true]);
    const behind = reconcile({ backend: { done: 2, total: 3 }, phase: "execute", plan, ticks: [true, false, false], seq: 1, record: undefined });
    assert.equal(behind.record?.ticks, undefined);
  });

  it("after Execute: the remembered count stands when NEO's drops (worktree removed)", () => {
    for (const phase of ["review", "review-gate", "finish", "done"]) {
      const r = reconcile({ backend: { done: 0, total: 3 }, phase, plan, seq: 300, record: record(3, { ticks: [true, true, true] }) });
      assert.deepEqual(r.progress, { done: 3, total: 3 }, phase);
      assert.deepEqual(r.ticks, [true, true, true]);
      assert.equal(r.restored, true);
    }
  });

  it("after Execute: the remembered count stands when NEO reports nothing", () => {
    for (const backend of [null, { done: 0, total: 0 }]) {
      const r = reconcile({ backend, phase: "done", plan, seq: 300, record: record(2) });
      assert.deepEqual(r.progress, { done: 2, total: 3 });
    }
  });

  it("after Execute: NEO's count wins when it is as far or further, and becomes the record", () => {
    const r = reconcile({ backend: { done: 3, total: 3 }, phase: "done", plan, seq: 300, record: record(2) });
    assert.deepEqual(r.progress, { done: 3, total: 3 });
    assert.equal(r.restored, false);
    assert.equal(r.record?.done, 3);
  });

  it("never reuses a count made for a different plan, and forgets it", () => {
    const other = { key: "tasks:X|steps:0,0,0", steps: 3 };
    const r = reconcile({ backend: { done: 0, total: 3 }, phase: "done", plan: other, seq: 300, record: record(3) });
    assert.deepEqual(r.progress, { done: 0, total: 3 });
    assert.equal(r.restored, false);
    assert.equal(r.record?.plan, other.key);
  });

  it("does not use a count for a plan it cannot identify, but keeps it", () => {
    const kept = record(3);
    const r = reconcile({ backend: { done: 0, total: 3 }, phase: "done", plan: undefined, seq: 300, record: kept });
    assert.deepEqual(r.progress, { done: 0, total: 3 });
    assert.equal(r.record, kept);
  });

  it("does not restore across a different step total", () => {
    const r = reconcile({ backend: { done: 0, total: 4 }, phase: "done", plan, seq: 300, record: record(3) });
    assert.deepEqual(r.progress, { done: 0, total: 4 });
    assert.equal(r.restored, false);
  });

  it("a planning phase drops the record", () => {
    const r = reconcile({ backend: { done: 0, total: 3 }, phase: "plan-gate", plan, seq: 300, record: record(3) });
    assert.equal(r.record, undefined);
    assert.deepEqual(r.progress, { done: 0, total: 3 });
  });

  it("an unchanged count keeps the record as it was, ticks and date included", () => {
    const kept = record(2, { ticks: [true, true, false] });
    const r = reconcile({ backend: { done: 2, total: 3 }, phase: "execute", plan, seq: 999, record: kept });
    assert.equal(r.record, kept);
  });

  it("a count is never carried into another session, even for a plan of the same shape", () => {
    const build = record(3, { session: "s1" });
    for (const phase of ["execute", "review", "done"]) {
      const r = reconcile({ backend: null, phase, plan, seq: 300, record: build, session: "s2" });
      assert.equal(r.progress, null, `${phase}: the new session has no count of its own`);
      assert.equal(r.restored, false);
      assert.equal(r.record, undefined, `${phase}: the other session's record is dropped`);
    }
    // A record from before sessions were tracked is not trusted for a session either.
    assert.equal(reconcile({ backend: null, phase: "done", plan, seq: 300, record: record(3), session: "s2" }).progress, null);
  });

  it("within its own session the remembered count still stands after Execute", () => {
    const counted = reconcile({ backend: { done: 3, total: 3 }, phase: "execute", plan, seq: 200, record: undefined, session: "s1" });
    assert.equal(counted.record?.session, "s1");
    const r = reconcile({ backend: { done: 0, total: 3 }, phase: "done", plan, seq: 300, record: counted.record, session: "s1" });
    assert.deepEqual(r.progress, { done: 3, total: 3 });
    assert.equal(r.restored, true);
  });

  it("clamps a count past its total", () => {
    const r = reconcile({ backend: { done: 9, total: 3 }, phase: "execute", plan, seq: 1, record: undefined });
    assert.deepEqual(r.progress, { done: 3, total: 3 });
  });
});

describe("staleAfter - which phases invalidate the record", () => {
  it("only a planning phase newer than the record", () => {
    const r = record(3);                       // seq 100
    assert.equal(staleAfter(r, "plan", 101), true);
    assert.equal(staleAfter(r, "plan-gate", 150), true);
    assert.equal(staleAfter(r, "plan", 99), false, "an old event replayed on reopen / reconnect");
    assert.equal(staleAfter(r, "execute", 500), false, "Execute again after review: same plan");
    assert.equal(staleAfter(r, "done", 500), false);
    assert.equal(staleAfter(r, "plan", undefined), true, "a planning phase of unknown age");
    assert.equal(staleAfter(undefined, "plan", 101), false);
  });
});
