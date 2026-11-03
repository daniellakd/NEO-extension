// PlanTracker end to end, on real folders: a project, a git worktree record, the worktree's plan.
// Each test is one of the situations Live Progress must survive.
import { MemoryStore } from "./vscodeStub";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type * as vscode from "vscode";
import { PlanTracker, PlanView, buildLive } from "../progress";

const PLAN = `# Todo CLI Implementation Plan

### Task 1: Todo model
- [ ] **Step 1: Write failing test**
- [ ] **Step 2: Implement Todo**

### Task 2: Implement JSON Storage
- [ ] **Step 3: Write failing test for save/load**
- [ ] **Step 4: Implement storage.py**

### Task 3: CLI commands
- [ ] **Step 5: add / list / done / delete**
`;
const TOTAL = 5;

/** The plan with these steps (0-based) ticked. */
function ticked(doc: string, steps: number[]): string {
  let n = -1;
  return doc.replace(/^- \[ \]/gm, (m) => (steps.includes(++n) ? "- [x]" : m));
}

const made: string[] = [];
afterEach(() => made.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A NEO project folder with its plan, and a worktree git knows about (as `git worktree add` leaves it). */
function project(doc = PLAN) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neo-project-"));
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "neo-worktree-"));
  made.push(root, tree);
  fs.mkdirSync(path.join(root, "docs", "neoag"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "neoag", "plan.md"), doc);
  fs.mkdirSync(path.join(root, ".git", "worktrees", "work"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", "work", "gitdir"), `${tree.split(path.sep).join("/")}/.git\n`);
  fs.mkdirSync(path.join(tree, "docs", "neoag"), { recursive: true });
  fs.writeFileSync(path.join(tree, "docs", "neoag", "plan.md"), doc);
  return {
    root,
    /** The agent ticks these steps in the worktree's copy. */
    tick: (steps: number[]) => fs.writeFileSync(path.join(tree, "docs", "neoag", "plan.md"), ticked(doc, steps)),
    /** Execute is over: the worktree is gone (git's record of it may linger, "prunable"). */
    removeWorktree: () => fs.rmSync(tree, { recursive: true, force: true }),
  };
}

/** A sidebar's PlanTracker for one project - a new one is a new VS Code window. */
function open(store: MemoryStore, id: string, root: string): PlanTracker {
  const tracker = new PlanTracker(store as unknown as vscode.Memento, () => {});
  tracker.start(id, root);
  return tracker;
}

/** What the panel shows once the plan files have been read for this count. */
async function show(tracker: PlanTracker, backend: { done: number; total: number } | null, phase: string, seq: number): Promise<PlanView> {
  tracker.view(backend, phase, seq);
  const t = tracker as unknown as { reading: boolean };
  while (t.reading) await new Promise((r) => setTimeout(r, 5));
  return tracker.view(backend, phase, seq);
}

function line(v: PlanView): string {
  if (!v.progress || !v.task) return "nothing";
  const t = v.task;
  const head = t.complete ? `All ${t.total} tasks done` : `Task ${t.index} of ${t.total} · ${t.title}`;
  return `${head} | ${t.tasksDone}/${t.total} tasks · ${v.progress.done} of ${v.progress.total} steps`;
}

/** Execute from start to finish, ticked in this order, as NEO's count and the files report it. */
async function execute(tracker: PlanTracker, p: ReturnType<typeof project>, order: number[], seq = 100): Promise<PlanView> {
  let v = await show(tracker, { done: 0, total: TOTAL }, "execute", seq);
  for (let i = 1; i <= order.length; i++) {
    p.tick(order.slice(0, i));
    v = await show(tracker, { done: i, total: TOTAL }, "execute", seq + i);
  }
  return v;
}

describe("PlanTracker - after Execute, when the worktree is removed", () => {
  it("Done shows the count Execute reached, not NEO's 0", async () => {
    const store = new MemoryStore();
    const p = project();
    const t = open(store, "p1", p.root);
    assert.equal(line(await execute(t, p, [0, 1, 2, 3, 4])), "All 3 tasks done | 3/3 tasks · 5 of 5 steps");
    p.removeWorktree();
    for (const phase of ["review", "review-gate", "finish", "done"]) {
      assert.equal(line(await show(t, { done: 0, total: TOTAL }, phase, 200)), "All 3 tasks done | 3/3 tasks · 5 of 5 steps", phase);
    }
  });

  it("keeps the exact ticks, so out-of-order work is still placed right", async () => {
    const store = new MemoryStore();
    const p = project();
    const t = open(store, "p1", p.root);
    await execute(t, p, [0, 2, 3]);                     // Task 2 done, Task 1 still open
    p.removeWorktree();
    assert.equal(line(await show(t, { done: 0, total: TOTAL }, "review", 200)), "Task 1 of 3 · Todo model | 1/3 tasks · 3 of 5 steps");
  });

  it("the Finish phase shows the plan rows", () => {
    const live = buildLive(
      { connection: "connected", mode: "project", phase: "finish", busy: true, atGate: false, awaiting: false, stopping: false,
        needsAttention: false, attentionReason: null, planProgress: { done: 0, total: 5 }, stream: "up", catchingUp: false },
      { unit: "task", index: 1, total: 3 }, null, null);
    assert.deepEqual(live.progress, { done: 0, total: 5 });
  });
});

describe("PlanTracker - VS Code closed and reopened", () => {
  it("a new window restores the task and the progress, with the worktree gone", async () => {
    const store = new MemoryStore();
    const p = project();
    await execute(open(store, "p1", p.root), p, [0, 1, 2]);
    p.removeWorktree();
    const reopened = open(store, "p1", p.root);
    // The history read on open replays the old phases - all older than what was recorded.
    for (const [phase, seq] of [["plan", 10], ["plan-gate", 20], ["execute", 100], ["review", 150]] as const) reopened.notePhase(phase, seq);
    assert.equal(line(await show(reopened, { done: 0, total: TOTAL }, "review", 150)), "Task 2 of 3 · Implement JSON Storage | 1/3 tasks · 3 of 5 steps");
  });

  it("reopened mid-Execute, NEO's live count is shown", async () => {
    const store = new MemoryStore();
    const p = project();
    await execute(open(store, "p1", p.root), p, [0, 1]);
    p.tick([0, 1, 2, 3]);                                // NEO went on while the window was closed
    const reopened = open(store, "p1", p.root);
    assert.equal(line(await show(reopened, { done: 4, total: TOTAL }, "execute", 300)), "Task 3 of 3 · CLI commands | 2/3 tasks · 4 of 5 steps");
  });
});

describe("PlanTracker - SSE disconnect and reconnect", () => {
  it("the caught-up (old) events keep the count; NEO's next count moves it on", async () => {
    const store = new MemoryStore();
    const p = project();
    const t = open(store, "p1", p.root);
    await execute(t, p, [0, 1]);                         // recorded at seq 102
    // Reconnect: the catch-up re-reads the history; only events newer than the last delivered are
    // applied, but even a replayed planning phase from before the record changes nothing.
    t.notePhase("plan-gate", 20);
    assert.equal(line(await show(t, { done: 2, total: TOTAL }, "execute", 102)), "Task 2 of 3 · Implement JSON Storage | 1/3 tasks · 2 of 5 steps");
    p.tick([0, 1, 2]);
    assert.equal(line(await show(t, { done: 3, total: TOTAL }, "execute", 130)), "Task 2 of 3 · Implement JSON Storage | 1/3 tasks · 3 of 5 steps");
  });

  it("NEO unreachable for a while after Execute: the remembered count stays", async () => {
    const store = new MemoryStore();
    const p = project();
    const t = open(store, "p1", p.root);
    await execute(t, p, [0, 1, 2, 3, 4]);
    p.removeWorktree();
    assert.equal(line(await show(t, null, "done", 200)), "All 3 tasks done | 3/3 tasks · 5 of 5 steps");
  });
});

describe("PlanTracker - switching projects and back", () => {
  it("each project keeps its own task and progress", async () => {
    const store = new MemoryStore();
    const a = project();
    const b = project(PLAN.replace("Todo model", "Parser"));
    const t = new PlanTracker(store as unknown as vscode.Memento, () => {});

    t.start("A", a.root);
    await execute(t, a, [0, 1, 2, 3, 4]);
    a.removeWorktree();
    t.stop();

    t.start("B", b.root);
    await execute(t, b, [0]);
    assert.equal(line(await show(t, { done: 1, total: TOTAL }, "execute", 300)), "Task 1 of 3 · Parser | 0/3 tasks · 1 of 5 steps");
    t.stop();

    t.start("A", a.root);
    assert.equal(line(await show(t, { done: 0, total: TOTAL }, "done", 400)), "All 3 tasks done | 3/3 tasks · 5 of 5 steps");
    t.stop();

    t.start("B", b.root);
    assert.equal(line(await show(t, { done: 1, total: TOTAL }, "execute", 401)), "Task 1 of 3 · Parser | 0/3 tasks · 1 of 5 steps");
  });
});

describe("PlanTracker - stale progress is never reused", () => {
  it("a re-plan newer than the record drops it", async () => {
    const store = new MemoryStore();
    const p = project();
    const t = open(store, "p1", p.root);
    await execute(t, p, [0, 1, 2, 3, 4]);
    p.removeWorktree();
    t.notePhase("plan", 500);                            // NEO re-plans
    assert.equal(line(await show(t, { done: 0, total: TOTAL }, "done", 600)), "Task 1 of 3 · Todo model | 0/3 tasks · 0 of 5 steps");
  });

  it("a re-plan seen only in the history on reopen drops it too", async () => {
    const store = new MemoryStore();
    const p = project();
    await execute(open(store, "p1", p.root), p, [0, 1, 2, 3, 4]);
    p.removeWorktree();
    const reopened = open(store, "p1", p.root);
    reopened.notePhase("plan-gate", 900);                // happened while the window was closed
    assert.equal(line(await show(reopened, { done: 0, total: TOTAL }, "review", 950)), "Task 1 of 3 · Todo model | 0/3 tasks · 0 of 5 steps");
  });

  it("a changed plan never gets the old count", async () => {
    const store = new MemoryStore();
    const p = project();
    await execute(open(store, "p1", p.root), p, [0, 1, 2, 3, 4]);
    p.removeWorktree();
    const changed = PLAN.replace("### Task 3: CLI commands", "### Task 3: CLI commands\n- [ ] **Step 6: docs**\n\n### Task 4: Packaging");
    fs.writeFileSync(path.join(p.root, "docs", "neoag", "plan.md"), changed);
    const reopened = open(store, "p1", p.root);
    assert.equal(line(await show(reopened, { done: 0, total: 6 }, "done", 950)), "Task 1 of 4 · Todo model | 0/4 tasks · 0 of 6 steps");
  });

  it("Execute again: NEO's count replaces the record, even when lower", async () => {
    const store = new MemoryStore();
    const p = project();
    const t = open(store, "p1", p.root);
    await execute(t, p, [0, 1, 2, 3, 4]);
    p.tick([0, 1]);                                      // a fresh worktree from the same plan
    assert.equal(line(await show(t, { done: 2, total: TOTAL }, "execute", 700)), "Task 2 of 3 · Implement JSON Storage | 1/3 tasks · 2 of 5 steps");
    p.removeWorktree();
    assert.equal(line(await show(t, { done: 0, total: TOTAL }, "done", 800)), "Task 2 of 3 · Implement JSON Storage | 1/3 tasks · 2 of 5 steps");
  });

  it("returning to Execute after review (same plan) keeps going from the record", async () => {
    const store = new MemoryStore();
    const p = project();
    const t = open(store, "p1", p.root);
    await execute(t, p, [0, 1, 2]);
    t.notePhase("review", 200);
    t.notePhase("execute", 210);                         // review asked for changes: not a new plan
    p.removeWorktree();
    assert.equal(line(await show(t, { done: 0, total: TOTAL }, "review-gate", 220)), "Task 2 of 3 · Implement JSON Storage | 1/3 tasks · 3 of 5 steps");
  });
});
