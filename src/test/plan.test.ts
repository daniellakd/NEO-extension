// The Design and Plan view (src/plan.ts): which documents, where each stands, what is in them, and
// opening the real file. Stage lists and gate events are shaped as NEO reports them.
import "./vscodeStub";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { currentTask, parsePlanOutline } from "../planOutline";
import { GateEventLike, PlanArtifacts, StageLike, documentGates, outlineDocument, outlinePlan, railStages, statusOf } from "../plan";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require("vscode");

const PLAN = `# Todo API Implementation Plan

**Goal:** a small FastAPI todo service.

### Task 1: Scaffold the app (FR-1, NFR-2)
- [ ] **Step 1: Write failing test**
- [ ] **Step 2: Create main.py**

### Task 2: Create endpoint
- [ ] **Step 3: Write failing test**
- [ ] **Step 4: POST /todos**
- [ ] **Step 5: 422 on bad input**

### Task 3: Delete endpoint
- [ ] **Step 6: DELETE /todos/{id}**

## Acceptance
- [ ] **Step 7: run the acceptance checks**
`;

const DESIGN = `# Todo API Design

Requirement source: the user's request.

## Scope
In and out.

## Architecture
\`\`\`
## not a section: code
\`\`\`

## Data model
## Error handling
`;

/** NEO's full-pipeline rail, as GET /api/projects/{id} returns it. */
function rail(active: string, opts: { brownfield?: boolean } = {}): StageLike[] {
  const all: StageLike[] = [
    { phase: "setup", label: "Setup", kind: "work", state: "", artifact: null },
    ...(opts.brownfield
      ? [
          { phase: "analysis", label: "Analysing", kind: "work", state: "", artifact: null },
          { phase: "analysis-gate", label: "Analysis", kind: "gate", state: "", artifact: "docs/neoag/analysis.md" },
        ]
      : []),
    { phase: "brainstorm", label: "Brainstorm", kind: "work", state: "", artifact: null },
    { phase: "design-gate", label: "Design", kind: "gate", state: "", artifact: "docs/neoag/design.md" },
    { phase: "plan", label: "Planning", kind: "work", state: "", artifact: null },
    { phase: "plan-gate", label: "Plan", kind: "gate", state: "", artifact: "docs/neoag/plan.md" },
    { phase: "execute", label: "Execute (TDD)", kind: "work", state: "", artifact: null },
    { phase: "review", label: "Review", kind: "work", state: "", artifact: null },
    { phase: "review-gate", label: "Merge", kind: "gate", state: "", artifact: "docs/neoag/review.md" },
    { phase: "finish", label: "Finish", kind: "work", state: "", artifact: null },
    { phase: "done", label: "Done", kind: "terminal", state: "", artifact: null },
  ];
  const at = all.findIndex((s) => s.phase === active);
  return all.map((s, i) => ({ ...s, state: i < at ? "done" : i === at ? "active" : "pending" }));
}

const ev = (phase: string, action: string, at: number, extra: Partial<GateEventLike> = {}): GateEventLike => ({
  phase,
  action,
  created_at: at,
  ...extra,
});

describe("which documents", () => {
  it("are the gates with an artifact up to the plan's - never the review gate", () => {
    assert.deepEqual(documentGates(rail("plan")).map((s) => s.phase), ["design-gate", "plan-gate"]);
  });

  it("include a brownfield project's analysis", () => {
    assert.deepEqual(documentGates(rail("plan", { brownfield: true })).map((s) => s.phase), ["analysis-gate", "design-gate", "plan-gate"]);
  });

  it("are only the plan in a quick-plan session, and none in a quick change", () => {
    const prd = rail("plan").filter((s) => !["brainstorm", "design-gate"].includes(s.phase));
    assert.deepEqual(documentGates(prd).map((s) => s.phase), ["plan-gate"]);
    const quick = rail("execute").filter((s) => ["execute", "review", "review-gate", "finish", "done"].includes(s.phase));
    assert.deepEqual(documentGates(quick), []);
  });

  it("follow NEO's names, not the extension's: a renamed plan gate is still the plan", () => {
    const stages = rail("plan").map((s) => (s.phase === "plan-gate" ? { ...s, phase: "planning-gate", label: "Build plan" } : s));
    const gates = documentGates(stages);
    assert.deepEqual(gates.map((s) => s.label), ["Design", "Build plan"]);
  });
});

describe("the rail as drawn", () => {
  const current = (stages: StageLike[]) => stages.filter((s) => s.state === "active").map((s) => s.label);

  it("waiting at the review gate: Review is current, not Merge (NEO's label for that gate)", () => {
    const drawn = railStages(rail("review-gate"), true, "review-gate");
    assert.deepEqual(current(drawn), ["Review"]);
    assert.equal(drawn.find((s) => s.phase === "review-gate")!.state, "waiting");
    assert.equal(drawn.find((s) => s.phase === "finish")!.state, "pending");
  });

  it("after approval NEO's own stages are drawn as they are: the next stage becomes current", () => {
    assert.deepEqual(current(railStages(rail("finish"), false)), ["Finish"]);
    assert.equal(railStages(rail("finish"), false).find((s) => s.phase === "review-gate")!.state, "done");
  });

  it("changes nothing when no gate is waiting, or a different gate is open", () => {
    const stages = rail("review-gate");
    assert.equal(railStages(stages, false), stages, "a gate phase NEO has not opened for a decision yet");
    assert.equal(railStages(stages, true, "plan-gate"), stages);
    assert.deepEqual(current(railStages(rail("execute"), true)), ["Execute (TDD)"], "no active gate: nothing moves");
  });
});

describe("reading the documents", () => {
  it("a design: its title and sections, not headings inside code", () => {
    assert.deepEqual(outlineDocument(DESIGN), {
      title: "Todo API Design",
      sections: ["Scope", "Architecture", "Data model", "Error handling"],
    });
  });

  it("a plan: its tasks and how many steps each has", () => {
    const p = outlinePlan(PLAN);
    assert.equal(p.title, "Todo API Implementation Plan");
    assert.deepEqual(p.tasks.map((t) => [t.title, t.steps, t.state]), [
      ["Scaffold the app", 2, "todo"],
      ["Create endpoint", 3, "todo"],
      ["Delete endpoint", 1, "todo"],
    ]);
    assert.equal(p.steps, 7);                       // the acceptance step counts too, as NEO counts it
  });

  it("a plan without task headings: its checklist items", () => {
    const p = outlinePlan("# Plan\n- [ ] Scaffold\n- [ ] Routes\n- [x] Tests\n");
    assert.deepEqual(p.tasks.map((t) => t.title), ["Scaffold", "Routes", "Tests"]);
  });
});

describe("where each document stands", () => {
  const stages = rail("plan-gate");
  const design = stages.find((s) => s.phase === "design-gate")!;
  // todo-api's real sequence: ready, changes requested, ready again, approved.
  const events = [
    ev("design-gate", "detected", 100),
    ev("design-gate", "rejected", 110, { feedback: "1 assumption(s) with no heading" }),
    ev("design-gate", "detected", 120),
    ev("design-gate", "approved", 130),
    ev("execute", "incomplete", 140),
  ];

  it("follows the gate events, and an approval answers the earlier request", () => {
    const s = statusOf(design, undefined, events, false);
    assert.equal(s.status, "approved");
    assert.equal(s.at, 130);
    assert.deepEqual(s.history.map((h) => h.status), ["ready", "changes", "ready", "approved"]);
    assert.equal(s.feedback, undefined);
  });

  it("at a re-opened gate: ready, with the changes requested last time", () => {
    const s = statusOf(design, undefined, events.slice(0, 3), true);
    assert.equal(s.status, "ready");
    assert.equal(s.feedback, "1 assumption(s) with no heading");
  });

  it("changes requested: says so, with the feedback", () => {
    const s = statusOf(design, undefined, events.slice(0, 2), false);
    assert.equal(s.status, "changes");
    assert.equal(s.feedback, "1 assumption(s) with no heading");
  });

  it("without events (an older NEO): from the rail", () => {
    const planning = rail("plan");
    const planGate = planning.find((s) => s.phase === "plan-gate")!;
    const before = planning.find((s) => s.phase === "plan")!;
    assert.equal(statusOf(planning.find((s) => s.phase === "design-gate")!, undefined, [], false).status, "approved");
    assert.equal(statusOf(planGate, before, [], false).status, "drafting");
    assert.equal(statusOf(planGate, undefined, [], false).status, undefined);
  });
});

describe("the view", () => {
  const detail = (events: GateEventLike[], extra: object = {}) => ({
    project: { path: "/nowhere" },
    gate_events: events,
    sessions: [{ id: "s1", created_at: 50 }],
    session_id: "s1",
    ...extra,
  });

  it("at the Plan gate: the plan is the open gate's document, every task still to do", () => {
    const a = new PlanArtifacts();
    a.noteDetail(detail([ev("design-gate", "detected", 60, { artifact_text: DESIGN }), ev("design-gate", "approved", 70), ev("plan-gate", "detected", 80)]));
    const view = a.build({
      mode: "project",
      stages: rail("plan-gate"),
      atGate: true,
      gate: { phase: "plan-gate", artifact: PLAN, artifact_path: "docs/neoag/plan.md" },
    });
    const [d, p] = view.items;
    assert.equal(d.label, "Design");
    assert.equal(d.status, "approved");
    assert.equal(d.atGate, false);
    assert.deepEqual(d.sections, ["Scope", "Architecture", "Data model", "Error handling"]);
    assert.equal(p.label, "Plan");
    assert.equal(p.kind, "plan");
    assert.equal(p.atGate, true);
    assert.equal(p.status, "ready");
    assert.equal(p.tasks!.length, 3);
    assert.ok(p.tasks!.every((t) => t.state === "todo"));
  });

  it("at the Review gate: no document is at its gate - the review card is left alone", () => {
    const a = new PlanArtifacts();
    a.noteDetail(detail([ev("plan-gate", "detected", 80, { artifact_text: PLAN }), ev("plan-gate", "approved", 90)]));
    const view = a.build({ mode: "project", stages: rail("review-gate"), atGate: true, gate: { phase: "review-gate", artifact: "# Review" } });
    assert.deepEqual(view.items.map((i) => i.phase), ["design-gate", "plan-gate"]);
    assert.ok(view.items.every((i) => !i.atGate));
  });

  it("during Execute: task states are Live Progress's, step counts the plan's", () => {
    const a = new PlanArtifacts();
    a.noteDetail(detail([ev("plan-gate", "detected", 80, { artifact_text: PLAN }), ev("plan-gate", "approved", 90)]));
    // What Live Progress computes for 3 of 7 steps ticked (src/planOutline.ts currentTask).
    const task = currentTask({ done: 3, total: 7 }, [parsePlanOutline(PLAN)], []);
    const view = a.build({ mode: "project", stages: rail("execute"), atGate: false, gate: null, live: { task } });
    const p = view.items.find((i) => i.kind === "plan")!;
    assert.deepEqual(p.tasks!.map((t) => [t.state, t.steps]), [["done", 2], ["current", 3], ["todo", 1]]);
    assert.deepEqual(p.current, { index: 2, total: 3, done: 1, complete: false });
    assert.equal(p.status, "approved");
  });

  it("a gate decided in an earlier session does not speak for this one", () => {
    const a = new PlanArtifacts();
    a.noteDetail(detail([ev("design-gate", "rejected", 10, { feedback: "old" })], { sessions: [{ id: "s2", created_at: 50 }], session_id: "s2" }));
    const view = a.build({ mode: "project", stages: rail("design-gate"), atGate: true, gate: { phase: "design-gate", artifact: DESIGN } });
    assert.equal(view.items[0].feedback, undefined);
  });

  it("before anything is produced, and outside a project: nothing", () => {
    const a = new PlanArtifacts();
    a.noteDetail(detail([]));
    assert.deepEqual(a.build({ mode: "project", stages: rail("setup"), atGate: false, gate: null }).items, []);
    assert.deepEqual(a.build({ mode: "noProject", stages: rail("plan-gate"), atGate: true, gate: null }).items, []);
  });
});

describe("opening the real document", () => {
  const made: string[] = [];
  afterEach(() => made.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  /** A project repository with a NEO-style worktree under .worktrees/. */
  function repo(): { root: string; tree: string } {
    // The long form of the path, as NEO stores a project's (Python's resolve()) and as git prints
    // it: on Windows the temp folder can be an 8.3 short name ("DANIEL~1") that git spells out.
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "neo-plan-")));
    made.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", "-b", "work/x", path.join(".worktrees", "x"));
    const tree = path.join(root, ".worktrees", "x");
    for (const dir of [root, tree]) fs.mkdirSync(path.join(dir, "docs", "neoag"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "neoag", "design.md"), DESIGN);
    fs.writeFileSync(path.join(root, "docs", "neoag", "plan.md"), PLAN);
    fs.writeFileSync(path.join(tree, "docs", "neoag", "plan.md"), PLAN.replace("- [ ]", "- [x]"));
    return { root, tree };
  }

  function recorder() {
    const calls: string[] = [];
    vscode.commands.executeCommand = async (cmd: string, uri: { fsPath: string }) => void calls.push(`${cmd} ${uri.fsPath}`);
    vscode.window.showTextDocument = async (uri: { fsPath: string }) => void calls.push(`source ${uri.fsPath}`);
    vscode.window.showInformationMessage = async (m: string) => void calls.push(`info ${m}`);
    return calls;
  }

  function opened(root: string, stages: StageLike[]): PlanArtifacts {
    const a = new PlanArtifacts();
    a.noteDetail({ project: { path: root }, gate_events: [], sessions: [], session_id: null });
    a.build({ mode: "project", stages, atGate: false, gate: null });
    return a;
  }

  it("the plan: a read-only preview of the worktree's copy, where Execute ticks it", async () => {
    const { root, tree } = repo();
    const calls = recorder();
    await opened(root, rail("execute")).onMessage({ type: "plan.open", phase: "plan-gate", as: "preview" });
    assert.deepEqual(calls, [`markdown.showPreview ${path.join(tree, "docs", "neoag", "plan.md")}`]);
  });

  it("the design: the project's own copy; the editor only when asked", async () => {
    const { root } = repo();
    const calls = recorder();
    const a = opened(root, rail("execute"));
    await a.onMessage({ type: "plan.open", phase: "design-gate", as: "preview" });
    await a.onMessage({ type: "plan.open", phase: "design-gate", as: "source" });
    const file = path.join(root, "docs", "neoag", "design.md");
    assert.deepEqual(calls, [`markdown.showPreview ${file}`, `source ${file}`]);
  });

  it("a missing document: a message, nothing opened", async () => {
    const { root } = repo();
    fs.rmSync(path.join(root, "docs", "neoag", "design.md"));
    const calls = recorder();
    await opened(root, rail("execute")).onMessage({ type: "plan.open", phase: "design-gate" });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^info NEO: Design \(docs\/neoag\/design\.md\) was not found/);
  });
});
