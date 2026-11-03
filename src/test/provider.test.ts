// ChatViewProvider end to end: the real provider, client and SSE stream against a mock NEO (real HTTP
// and SSE), with a fake webview recording every state posted. Stop, reconnect, switching, notices.
import { MemoryStore, stubState } from "./vscodeStub";
import { MockNeo } from "./mockNeo";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type * as vscode from "vscode";
import { ChatViewProvider } from "../chatViewProvider";

const PLAN = `# Plan

### Task 1: Todo model
- [ ] **Step 1: Write failing test**
- [ ] **Step 2: Implement**

### Task 2: Implement JSON Storage
- [ ] **Step 3: Failing test for save/load**
- [ ] **Step 4: Implement storage.py**

### Task 3: CLI commands
- [ ] **Step 5: add / list / done / delete**
`;

interface Live {
  activity: string;
  action: string | null;
  note: { tone: string; text: string } | null;
  progress: { done: number; total: number } | null;
  task: { index: number; title?: string; complete?: boolean } | null;
  stream: { state: string; catchingUp?: boolean };
}
interface Posted {
  type: string;
  state?: { project?: { id: string }; mode: string; busy: boolean; awaiting: boolean; atGate: boolean; connection: string; phase?: string; live?: Live };
  events?: { seq?: number }[];
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  // Every step runs: a folder Windows still holds open must not leave a server listening.
  for (const f of cleanup.splice(0).reverse()) {
    try {
      await f();
    } catch {
      // A temp folder left behind is harmless.
    }
  }
});

/** A project folder with its plan and a worktree, as NEO leaves them during Execute. */
function folder(first = "Todo model") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neo-provider-"));
  // Changes Review runs a read-only `git` in the project folder; on Windows it can hold it a moment.
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const doc = PLAN.replace("Todo model", first);
  const tree = path.join(root, ".worktrees", "work");
  fs.mkdirSync(path.join(root, "docs", "neoag"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "neoag", "plan.md"), doc);
  fs.mkdirSync(path.join(root, ".git", "worktrees", "work"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", "work", "gitdir"), `${tree.split(path.sep).join("/")}/.git\n`);
  const tick = (steps: number[]) => {
    let n = -1;
    fs.mkdirSync(path.join(tree, "docs", "neoag"), { recursive: true });
    fs.writeFileSync(path.join(tree, "docs", "neoag", "plan.md"), doc.replace(/^- \[ \]/gm, (m) => (steps.includes(++n) ? "- [x]" : m)));
  };
  tick([]);
  return { root, doc, tick };
}

/** A running mock NEO with one project per folder, and a sidebar showing the first. */
async function sidebar(projects: { id: string; first?: string; busy?: boolean; done?: number }[]) {
  const neo = new MockNeo();
  stubState.serverUrl = await neo.listen();
  cleanup.push(() => neo.close());
  const folders = new Map<string, ReturnType<typeof folder>>();
  for (const p of projects) {
    const f = folder(p.first);
    folders.set(p.id, f);
    neo.add({ id: p.id, path: f.root, busy: p.busy ?? true, plan_progress: { done: p.done ?? 0, total: 5 } });
    neo.record(p.id, { kind: "phase", phase: "plan" });
    neo.record(p.id, { kind: "gate", phase: "plan-gate", artifact_path: "docs/neoag/plan.md", artifact: f.doc, checks: [] });
    neo.record(p.id, { kind: "phase", phase: "execute" });
  }
  stubState.folders = [folders.get(projects[0].id)!.root];
  stubState.quickPick = null;

  const vs = require("vscode") as { Uri: { file(p: string): vscode.Uri } };
  const provider = new ChatViewProvider(vs.Uri.file(path.resolve(__dirname, "..", "..")), new MemoryStore() as unknown as vscode.Memento);
  cleanup.push(() => provider.dispose());
  const posted: Posted[] = [];
  let send: (m: unknown) => void = () => {};
  provider.resolveWebviewView({
    webview: {
      options: {}, html: "", cspSource: "vscode-resource:", asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: (cb: (m: unknown) => void) => { send = cb; return { dispose() {} }; },
      // VS Code copies a message when it is posted (structured clone); so does this.
      postMessage: async (m: Posted) => { posted.push(JSON.parse(JSON.stringify(m))); return true; },
    },
    onDidDispose: () => ({ dispose() {} }),
  } as unknown as vscode.WebviewView);

  const state = () => [...posted].reverse().find((m) => m.type === "state")?.state;
  const live = () => state()?.live;
  const until = async (pred: () => boolean, ms = 5000, what = "condition") => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}; last live: ${JSON.stringify(live())}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  /** The 10-second re-read, fired now instead of waited for. */
  const resync = () => (provider as unknown as { resync(): Promise<void> }).resync();
  /** chat.js: Stop is shown while working (busy, not awaiting, not at a gate) or while stopping. */
  const stopShown = () => {
    const s = state()!;
    return Boolean((s.connection === "connected" && s.mode === "project" && s.busy && !s.awaiting && !s.atGate) || s.live?.activity === "stopping");
  };

  await provider.connect();
  await until(() => live()?.stream.state === "up" && Boolean(live()?.progress), 5000, "the project to open");
  return { neo, provider, posted, folders, send: (m: unknown) => send(m), state, live, until, resync, stopShown };
}

describe("Stop / Abort", () => {
  it("one request for two clicks: stopping, then stopped, Stop hidden", async () => {
    const t = await sidebar([{ id: "A" }]);
    assert.equal(t.stopShown(), true);
    t.send({ type: "abort" });
    t.send({ type: "abort" });
    await t.until(() => t.live()?.activity === "stopping", 1000, "stopping");
    await t.until(() => t.live()?.activity === "stopped", 3000, "stopped");
    assert.equal(t.neo.calls.filter((c) => c.endsWith("/abort")).length, 1);
    assert.equal(t.stopShown(), false);
    assert.match(t.live()!.note!.text, /Turn stopped - nothing was undone/);
  });

  it("the 'ended with an error' stall NEO reports for the stopped turn is said as the Stop; a message resumes", async () => {
    const t = await sidebar([{ id: "A" }]);
    t.send({ type: "abort" });
    await t.until(() => t.live()?.activity === "stopped", 3000, "stopped");
    Object.assign(t.neo.projects.get("A")!, { needs_attention: true, attention_reason: "the turn in execute ended with an error" });
    t.neo.emit("A", { kind: "idle" });
    t.neo.emit("A", { kind: "notice", stalled: "the turn in execute ended with an error", phase: "execute" });
    await new Promise((r) => setTimeout(r, 150));
    await t.resync();
    assert.equal(t.live()!.activity, "stopped");
    assert.match(t.live()!.note!.text, /Turn stopped/);

    t.send({ type: "send", text: "continue" });
    await t.until(() => t.live()?.activity === "working", 3000, "working again");
    assert.equal(t.live()!.note, null);
    assert.equal(t.stopShown(), true);
  });

  it("an error after a new turn started is a real failure, not the Stop", async () => {
    const t = await sidebar([{ id: "A" }]);
    t.send({ type: "abort" });
    await t.until(() => t.live()?.activity === "stopped", 3000, "stopped");
    // NEO starts a turn on its own; that turn then fails.
    t.neo.projects.get("A")!.busy = true;
    t.neo.emit("A", { kind: "status", busy: true });
    await t.until(() => t.live()?.activity === "working", 2000, "the new turn");
    Object.assign(t.neo.projects.get("A")!, { busy: false, needs_attention: true, attention_reason: "the turn in execute ended with an error" });
    t.neo.emit("A", { kind: "idle" });
    t.neo.emit("A", { kind: "notice", stalled: "the turn in execute ended with an error", phase: "execute" });
    await new Promise((r) => setTimeout(r, 150));
    await t.resync();
    assert.equal(t.live()!.activity, "attention");
    assert.equal(t.live()!.note!.text, "Waiting on you: the turn in execute ended with an error");
  });

  it("an error with no Stop at all is shown as one", async () => {
    const t = await sidebar([{ id: "A" }]);
    Object.assign(t.neo.projects.get("A")!, { busy: false, needs_attention: true, attention_reason: "the turn in execute ended with an error" });
    t.neo.emit("A", { kind: "idle" });
    await t.resync();
    assert.equal(t.live()!.activity, "attention");
  });
});

describe("Stalled / resumed", () => {
  it("'Waiting on you' goes as soon as the user writes, and a resumed notice shows", async () => {
    const t = await sidebar([{ id: "A" }]);
    Object.assign(t.neo.projects.get("A")!, { busy: false, needs_attention: true, attention_reason: "the turn ended in execute without a phase signal" });
    t.neo.emit("A", { kind: "idle" });
    t.neo.emit("A", { kind: "notice", stalled: "the turn ended in execute without a phase signal", phase: "execute" });
    await t.resync();
    assert.equal(t.live()!.activity, "attention");
    assert.equal(t.posted.filter((m) => m.type === "state").at(-1)!.state!.live!.note!.text,
      "Waiting on you: the turn ended in execute without a phase signal");

    t.send({ type: "send", text: "go on" });
    await t.until(() => t.live()?.activity === "working", 2000, "working");
    assert.equal(t.live()!.note, null, "no stale 'Waiting on you' while NEO works");
    t.neo.emit("A", { kind: "notice", resumed: "execute", attempt: 1, limit: 3 });
    await t.until(() => /resumed/.test(t.live()?.note?.text ?? ""), 2000, "the resumed notice");
  });
});

describe("SSE disconnect and reconnect", () => {
  it("reconnecting, then caught up: missed events once, one subscription, the project and progress kept", async () => {
    const t = await sidebar([{ id: "A" }]);
    t.neo.refuseStreams = true;
    t.neo.drop("A");
    await t.until(() => t.live()?.stream.state === "reconnecting", 2000, "reconnecting");
    const missed = [
      t.neo.record("A", { kind: "tool", tool: "edit", status: "running", title: "", input: { filePath: "/p/storage.py" }, part: "x" }),
      t.neo.record("A", { kind: "text", text: "Implemented save/load." }),
    ];
    t.folders.get("A")!.tick([0, 1, 2]);
    t.neo.projects.get("A")!.plan_progress = { done: 3, total: 5 };
    await new Promise((r) => setTimeout(r, 1500));
    t.neo.refuseStreams = false;
    await t.until(() => t.live()?.stream.state === "up" && !t.live()?.stream.catchingUp && t.live()?.progress?.done === 3, 10000, "caught up");
    const after = t.neo.emit("A", { kind: "text", text: "after" });
    await new Promise((r) => setTimeout(r, 200));

    const seqs = t.posted.filter((m) => m.type === "events").flatMap((m) => m.events ?? []).map((e) => e.seq).filter((s) => s !== undefined);
    for (const e of [...missed, after]) assert.equal(seqs.filter((s) => s === e.seq).length, 1, `event ${e.seq} delivered once`);
    assert.equal(new Set(seqs).size, seqs.length, "no duplicates");
    assert.equal(t.neo.maxStreams.get("A"), 1);
    assert.equal(t.neo.open("A"), 1);
    assert.equal(t.state()!.project!.id, "A");
    assert.equal(t.live()!.task!.title, "Implement JSON Storage");
    assert.equal(t.live()!.action, "Editing storage.py");
  });
});

describe("Project switching", () => {
  it("no state leaks between projects; the stream state starts over; switching back restores", async () => {
    const t = await sidebar([{ id: "A", busy: true, done: 2 }, { id: "B", first: "Parser", busy: false, done: 1 }]);
    t.folders.get("A")!.tick([0, 1]);
    t.folders.get("B")!.tick([0]);
    await t.resync();
    t.neo.emit("A", { kind: "tool", tool: "bash", status: "running", title: "", input: { command: "pytest -q" }, part: "a" });
    await t.until(() => t.live()?.action === "Running tests", 2000, "A's action");

    const before = t.posted.length;
    stubState.quickPick = (items) => items.find((i) => i.id === "B");
    await t.provider.switchProject();
    await t.until(() => t.state()?.project?.id === "B" && t.live()?.stream.state === "up" && Boolean(t.live()?.progress), 5000, "B");
    const loading = t.posted.slice(before).find((m) => m.type === "state" && m.state!.mode === "loading");
    assert.equal(loading?.state?.live?.stream.state, "off", "no 'up' carried over from A while B connects");
    assert.equal(t.live()!.task!.title, "Parser");
    assert.deepEqual(t.live()!.progress, { done: 1, total: 5 });
    assert.equal(t.live()!.action, null);
    assert.equal(t.live()!.note, null);
    assert.equal(t.stopShown(), false);
    assert.equal(t.neo.open("A"), 0);

    stubState.quickPick = (items) => items.find((i) => i.id === "A");
    await t.provider.switchProject();
    await t.until(() => t.state()?.project?.id === "A" && t.live()?.stream.state === "up" && Boolean(t.live()?.progress), 5000, "A again");
    assert.equal(t.live()!.task!.title, "Implement JSON Storage");
    assert.deepEqual(t.live()!.progress, { done: 2, total: 5 });
    assert.equal(t.neo.open("B"), 0);
  });
});

describe("Progress and phases", () => {
  it("an edit of plan.md moves progress within a second, not at the next 10-second read", async () => {
    const t = await sidebar([{ id: "A" }]);
    t.folders.get("A")!.tick([0]);
    t.neo.projects.get("A")!.plan_progress = { done: 1, total: 5 };
    t.neo.emit("A", { kind: "tool", tool: "edit", status: "completed", title: "", input: { filePath: "/p/.worktrees/work/docs/neoag/plan.md" }, part: "t" });
    await t.until(() => t.live()?.progress?.done === 1, 1500, "progress after the plan edit");
  });

  it("Finish: 'Preparing the merge', with the plan rows", async () => {
    const t = await sidebar([{ id: "A" }]);
    Object.assign(t.neo.projects.get("A")!, { phase: "finish" });
    t.neo.emit("A", { kind: "phase", phase: "finish" });
    t.neo.emit("A", { kind: "text", text: "Merging the branch." });
    await t.until(() => t.state()?.phase === "finish" && t.live()?.action === "Preparing the merge", 2000, "finish");
    assert.ok(t.live()!.progress);
  });
});
