// What belongs to one project or one session stays there: Live Progress across sessions, the rail at
// the review gate, the composer's draft and chips across projects (and through a reconnect), the +
// menu sharing "@"'s attach path, and Go to's Changes count. The real provider, client and SSE stream
// against the mock NEO, as in commands.test.
import { MemoryStore, stubState } from "./vscodeStub";
import { MockNeo } from "./mockNeo";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type * as vscode from "vscode";
import { ChatViewProvider } from "../chatViewProvider";

const ROOT = path.resolve(__dirname, "..", "..");

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) {
    try {
      await f();
    } catch {
      // A temp folder left behind is harmless.
    }
  }
  Object.assign(stubState, { quickPick: null, files: [], infos: [], warnings: [] });
});

async function until(pred: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-scope-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

interface State {
  mode: string;
  phase?: string;
  project?: { id: string };
  attachments: { id: string; label: string }[];
  rail?: { phase: string; label: string; state: string }[];
  live?: { task: { complete?: boolean; index: number } | null; progress: { done: number; total: number } | null };
  sessions?: { active?: { id: string } | null };
}
interface Posted {
  type: string;
  state?: State;
  text?: string;
  level?: string;
}
type Internals = {
  onMessage(m: { type: string; [k: string]: unknown }): Promise<void>;
  attachments: unknown[];
  changes: { running: boolean; snapshot: unknown };
};

const FULL = [
  { phase: "brainstorm", label: "Brainstorm", kind: "work", state: "done" },
  { phase: "design-gate", label: "Design", kind: "gate", state: "done", artifact: "docs/neoag/design.md" },
  { phase: "plan", label: "Planning", kind: "work", state: "done" },
  { phase: "plan-gate", label: "Plan", kind: "gate", state: "done", artifact: "docs/neoag/plan.md" },
  { phase: "execute", label: "Execute (TDD)", kind: "work", state: "done" },
  { phase: "review", label: "Review", kind: "work", state: "done" },
  { phase: "review-gate", label: "Merge", kind: "gate", state: "done", artifact: "docs/neoag/review.md" },
  { phase: "finish", label: "Finish", kind: "work", state: "done" },
  { phase: "done", label: "Done", kind: "terminal", state: "active" },
];
const QUICK = [
  { phase: "execute", label: "Execute (TDD)", kind: "work", state: "active" },
  { phase: "review", label: "Review", kind: "work", state: "pending" },
  { phase: "review-gate", label: "Merge", kind: "gate", state: "pending", artifact: "docs/neoag/review.md" },
  { phase: "finish", label: "Finish", kind: "work", state: "pending" },
  { phase: "done", label: "Done", kind: "terminal", state: "pending" },
];
const PLAN = "# Plan\n\n### Task 1: A\n- [x] one\n### Task 2: B\n- [x] two\n";

/** A sidebar on project p1 (its own folder), with p2 registered in another folder. */
async function setup(opts: { phase?: string; stages?: Record<string, unknown>[]; planProgress?: { done: number; total: number } } = {}) {
  const neo = new MockNeo();
  stubState.serverUrl = await neo.listen();
  cleanup.push(() => neo.close());
  const a = tempDir();
  const b = tempDir();
  stubState.folders = [a];
  for (const [id, dir, name] of [["p1", a, "neo-extension-e2e"], ["p2", b, "todo-api"]] as const) {
    neo.add({ id, path: dir, name, phase: id === "p1" ? opts.phase ?? "execute" : "execute", stages: id === "p1" ? opts.stages ?? FULL : QUICK });
    neo.startSession(id, { id: `${id}-s1`, kind: "full", title: "Build", request: "x", created_at: 1000 });
    neo.record(id, { kind: "phase", phase: id === "p1" ? opts.phase ?? "execute" : "execute" });
  }
  if (opts.planProgress) neo.projects.get("p1")!.plan_progress = opts.planProgress;
  const vs = require("vscode") as { Uri: { file(p: string): vscode.Uri } };
  const provider = new ChatViewProvider(vs.Uri.file(ROOT), new MemoryStore() as unknown as vscode.Memento);
  cleanup.push(() => provider.dispose());
  const posted: Posted[] = [];
  provider.resolveWebviewView({
    visible: true,
    webview: {
      options: {}, html: "", cspSource: "vscode-resource:", asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (m: Posted) => { posted.push(JSON.parse(JSON.stringify(m))); return true; },
    },
    onDidDispose: () => ({ dispose() {} }),
    onDidChangeVisibility: () => ({ dispose() {} }),
  } as unknown as vscode.WebviewView);
  await provider.connect();
  const state = () => [...posted].reverse().find((m) => m.type === "state")?.state;
  await until(() => Boolean(state()?.sessions?.active) && neo.open("p1") === 1, "p1 open with its stream");
  const internals = provider as unknown as Internals;
  const last = (type: string) => [...posted].reverse().find((m) => m.type === type);
  return { neo, a, b, provider, posted, state, last, internals, send: (m: { type: string; [k: string]: unknown }) => internals.onMessage(m) };
}

async function switchTo(t: Awaited<ReturnType<typeof setup>>, id: string): Promise<void> {
  stubState.quickPick = (items) => items.find((i) => i.id === id);
  await t.provider.switchProject();
  stubState.quickPick = null;
  await until(() => t.state()?.mode === "project" && t.state()?.project?.id === id, `the sidebar on ${id}`);
}

// --- Live Progress belongs to its session -------------------------------------------------------

describe("Live Progress is scoped to the session that produced it", () => {
  it("a finished Full Pipeline reads 'All N tasks done'; a new Quick Change session shows none of it", async () => {
    const t = await setup({ phase: "done", stages: FULL, planProgress: { done: 2, total: 2 } });
    fs.mkdirSync(path.join(t.a, "docs", "neoag"), { recursive: true });
    fs.writeFileSync(path.join(t.a, "docs", "neoag", "plan.md"), PLAN);
    await until(() => Boolean(t.state()?.live?.task?.complete), "the finished plan");
    assert.deepEqual(t.state()!.live!.progress, { done: 2, total: 2 });

    // A Quick Change starts. NEO's count still reads the merged plan on main (2 of 2): not this work's.
    const p = t.neo.projects.get("p1")!;
    t.neo.startSession("p1", { id: "p1-s2", kind: "quick", title: "Health", request: "add /health" });
    Object.assign(p, { phase: "execute", stages: QUICK });
    t.neo.emit("p1", { kind: "phase", phase: "execute" });
    await until(() => t.state()?.sessions?.active?.id === "p1-s2" && t.state()?.phase === "execute", "the new session");
    await until(() => t.state()?.live?.progress === null, "no inherited progress");
    assert.equal(t.state()!.live!.task, null);

    // ...and its review and Done still show nothing of the old build.
    Object.assign(p, { phase: "done", stages: QUICK.map((s) => ({ ...s, state: s.phase === "done" ? "active" : "done" })) });
    t.neo.emit("p1", { kind: "phase", phase: "done" });
    await until(() => t.state()?.phase === "done", "the quick change done");
    assert.equal(t.state()!.live!.progress, null);
    assert.equal(t.state()!.live!.task, null);
  });
});

// --- the rail at the review gate --------------------------------------------------------------

describe("the rail while the review gate waits", () => {
  it("Review stays current until approval advances the pipeline; Merge is not highlighted", async () => {
    const atGate = FULL.map((s, i) => ({ ...s, state: i < 6 ? "done" : i === 6 ? "active" : "pending" }));
    const t = await setup({ phase: "review-gate", stages: atGate });
    Object.assign(t.neo.projects.get("p1")!, { at_gate: true, gate: { title: "Code review", artifact_path: "docs/neoag/review.md", checks: [] } });
    await t.provider.refresh();
    await until(() => Boolean(t.state()?.rail?.some((s) => s.state === "waiting")), "the gate waiting");
    const current = (t.state()!.rail ?? []).filter((s) => s.state === "active").map((s) => s.label);
    assert.deepEqual(current, ["Review"]);
    assert.equal(t.state()!.rail!.find((s) => s.label === "Merge")!.state, "waiting");
  });
});

// --- the composer belongs to its project --------------------------------------------------------

describe("draft and attached context are scoped to their project", () => {
  it("project A's draft and chip never show in project B; switching back restores them", async () => {
    const t = await setup();
    await t.send({ type: "draft", text: "remember this draft" });
    const vs = require("vscode") as { Uri: { file(p: string): vscode.Uri } };
    t.internals.attachments.push({ id: "att-a", kind: "file", uri: vs.Uri.file(path.join(t.a, "main.py")), path: "main.py", language: "python", chars: 3 });

    await switchTo(t, "p2");
    assert.equal(t.last("composer")!.text, "", "B starts with an empty box");
    assert.deepEqual(t.state()!.attachments, [], "no chip from A in B");

    await t.send({ type: "draft", text: "todo draft" });
    await switchTo(t, "p1");
    assert.equal(t.last("composer")!.text, "remember this draft");
    assert.deepEqual(t.state()!.attachments.map((a) => a.id), ["att-a"]);

    await switchTo(t, "p2");
    assert.equal(t.last("composer")!.text, "todo draft", "B's own draft comes back too");
    assert.deepEqual(t.state()!.attachments, []);
  });

  it("a disconnect and reconnect on the same project keeps its draft and chips", async () => {
    const t = await setup();
    await t.send({ type: "draft", text: "keep me" });
    t.internals.attachments.push({ id: "att-1", kind: "selection", uri: {}, path: "app.py", lines: [1, 2], text: "x", language: "python", chars: 1 });
    const composersBefore = t.posted.filter((m) => m.type === "composer").length;
    t.neo.offline = true;
    t.neo.drop("p1");
    await t.provider.retry();                  // fails: NEO is down
    t.neo.offline = false;
    await t.provider.retry();
    await until(() => t.state()?.mode === "project" && t.neo.open("p1") >= 1, "reconnected");
    assert.equal(t.posted.filter((m) => m.type === "composer").length, composersBefore, "the box is never replaced");
    assert.deepEqual(t.state()!.attachments.map((a) => a.id), ["att-1"]);
    await t.send({ type: "ready" });            // even a reloaded webview gets the draft back
    assert.equal(t.last("composer")!.text, "keep me");
  });
});

// --- + and @ share one attach path ---------------------------------------------------------

describe("the + menu and @ attach through the same path", () => {
  it("offers Add Current File, Add Selection and Add Workspace File, always", async () => {
    const t = await setup();
    let offered: { label?: string; description?: string }[] = [];
    stubState.quickPick = (items) => {
      offered = items as typeof offered;
      return undefined;
    };
    await t.provider.addContext("menu");
    assert.deepEqual(offered.map((i) => i.label), ["$(file) Add Current File", "$(selection) Add Selection", "$(search) Add Workspace File…"]);
    assert.equal(offered[0].description, "no file is open in the editor");
  });

  it("a workspace file: the same chip, the same refusals (binary, too large), the same duplicate check", async () => {
    const t = await setup();
    const good = path.join(t.a, "main.py");
    const binary = path.join(t.a, "logo.png");
    const huge = path.join(t.a, "big.txt");
    fs.writeFileSync(good, "print('hi')\n");
    fs.writeFileSync(binary, Buffer.from([0x89, 0x50, 0x00, 0x01]));
    fs.writeFileSync(huge, "x".repeat(40_001));
    stubState.files = [good, binary, huge];
    const toasts = () => t.posted.filter((m) => m.type === "toast").map((m) => m.text ?? "");

    /** Attach `file` through "+ → Add Workspace File" or through "@". */
    const attach = async (file: string, via: "menu" | "at") => {
      stubState.quickPick = (items) =>
        (items as { action?: string; uri?: { fsPath: string } }[]).find((i) => i.action === "choose" || i.uri?.fsPath === path.resolve(file));
      await t.provider.addContext(via);
    };

    for (const via of ["menu", "at"] as const) {
      const before = toasts().length;
      await attach(binary, via);
      await attach(huge, via);
      assert.match(toasts()[before], /logo\.png looks like a binary file/, via);
      assert.match(toasts()[before + 1], /big\.txt is 40,001 characters/, via);
    }
    await attach(good, "menu");
    assert.deepEqual(t.state()!.attachments.map((a) => a.label), ["main.py"]);
    await attach(good, "at");
    assert.match(toasts()[toasts().length - 1], /main\.py is already attached/, "@ sees what + attached: one list");
    assert.equal(t.state()!.attachments.length, 1);
  });
});

// --- Go to's Changes ------------------------------------------------------------------------

describe("Go to… Changes", () => {
  it("says git could not be read, instead of a misleading '0 files'", async () => {
    const t = await setup({ phase: "review" });
    await until(() => !t.internals.changes.running && t.internals.changes.snapshot !== null, "the changes read");
    let offered: { label?: string; description?: string }[] = [];
    stubState.quickPick = (items) => {
      offered = items as typeof offered;
      return undefined;
    };
    await t.provider.goTo();
    const changes = offered.find((i) => /Changes/.test(i.label ?? ""));
    assert.equal(changes?.description, "could not read git");
  });
});
