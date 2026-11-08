// First run, offline NEO, reconnecting, and what failures say: the real provider, client and SSE
// stream against the mock NEO, with the error model checked on its own first.
import { MemoryStore, stubState } from "./vscodeStub";
import { MockNeo } from "./mockNeo";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type * as vscode from "vscode";
import { ChatViewProvider } from "../chatViewProvider";
import { describeError } from "../errors";
import { NeoClient, NeoHttpError, NeoUnreachable } from "../neoClient";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) {
    try {
      await f();
    } catch {
      // A temp folder left behind is harmless.
    }
  }
  stubState.warnings.length = 0;
  stubState.errors.length = 0;
});

interface Problem { summary: string; hint?: string; detail?: string; config?: boolean }
interface State {
  mode: string;
  connection: string;
  serverUrl: string;
  offline?: Problem;
  problem?: Problem;
  project?: { id: string; name: string };
  folderName?: string;
  attachments: { id: string }[];
  phase?: string;
  stream: string;
  ready: boolean;
}
interface Posted {
  type: string;
  state?: State;
  text?: string;
  level?: string;
  message?: string;
  hint?: string;
  detail?: string;
  outcome?: string;
}

type Internals = {
  resync(): Promise<void>;
  onMessage(m: { type: string; [k: string]: unknown }): Promise<void>;
  attachments: unknown[];
};

function tempDir(name = "neo-onboard-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

/** A URL nothing listens on: connecting is refused at once, on Windows and Linux alike. */
async function deadUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

async function until(pred: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function sidebar(folder: string | undefined) {
  stubState.folders = folder ? [folder] : [];
  const vs = require("vscode") as { Uri: { file(p: string): vscode.Uri } };
  const provider = new ChatViewProvider(vs.Uri.file(path.resolve(__dirname, "..", "..")), new MemoryStore() as unknown as vscode.Memento);
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
  } as unknown as vscode.WebviewView);
  const internals = provider as unknown as Internals;
  const state = () => [...posted].reverse().find((m) => m.type === "state")?.state;
  const last = (type: string) => [...posted].reverse().find((m) => m.type === type);
  return { provider, posted, state, last, internals, send: (m: { type: string; [k: string]: unknown }) => internals.onMessage(m) };
}

/** A running mock NEO with one project in a folder, and a sidebar open on it, stream up. */
async function onProject(opts: { phase?: string } = {}) {
  const neo = new MockNeo();
  stubState.serverUrl = await neo.listen();
  cleanup.push(() => neo.close());
  const root = tempDir();
  const id = "p1";
  neo.add({ id, path: root, name: "todo-api", busy: false, phase: opts.phase ?? "execute" });
  neo.startSession(id, { id: "s1", kind: "full", title: "Build", request: "A todo API", created_at: 1000 });
  neo.record(id, { kind: "user", note: "kickoff", text: "Build a todo API" });
  neo.record(id, { kind: "phase", phase: opts.phase ?? "execute" });
  const t = sidebar(root);
  await t.provider.connect();
  await until(() => t.state()?.mode === "project" && neo.open(id) === 1, "the project and its stream");
  // Context the user attached and has not sent yet.
  const vs = require("vscode") as { Uri: { file(p: string): vscode.Uri } };
  t.internals.attachments.push({
    id: "att-1", kind: "selection", uri: vs.Uri.file(path.join(root, "app.py")), path: "app.py",
    lines: [1, 2], text: "print('hi')", language: "python", chars: 11,
  });
  return { ...t, neo, id, root };
}

const mutating = (calls: string[]) => calls.filter((c) => c.startsWith("POST"));

// --- the error model ---------------------------------------------------------------------------

describe("what an error says", () => {
  it("NEO's known refusals become plain words; the original stays in the details", () => {
    const dup = describeError(new NeoHttpError(409, "a project named 'todo' already exists", "POST", "/api/projects"), "createProject");
    assert.equal(dup.summary, "Could not create the NEO project.");
    assert.match(dup.hint!, /already exists.*Projects/);
    assert.match(dup.detail!, /^HTTP 409 · POST \/api\/projects\na project named 'todo' already exists$/);
    assert.equal(dup.offline, false);

    const notEmpty = describeError(new NeoHttpError(422, "C:\\p\\todo already exists and is not empty", "POST", "/api/projects"), "createProject");
    assert.match(notEmpty.hint!, /not empty.*empty folder/);

    const busy = describeError(new NeoHttpError(409, "the agent is still working — wait for this session to finish"), "startSession");
    assert.match(busy.hint!, /still working/);

    const runtime = describeError(new NeoHttpError(502, "opencode unavailable: boom"), "send");
    assert.match(runtime.hint!, /agent runtime/);
    assert.equal(runtime.summary, "Your message was not sent.");

    const gone = describeError(new NeoHttpError(404, "project not found"), "loadProject");
    assert.equal(gone.summary, "Could not load the NEO project.");
    assert.match(gone.hint!, /no longer has this project/);
  });

  it("an unrecognised refusal keeps NEO's words; a server error is not dumped into the summary", () => {
    const odd = describeError(new NeoHttpError(409, "not at a gate"), "approve");
    assert.equal(odd.hint, "Not at a gate");
    const crash = describeError(new NeoHttpError(500, "Traceback (most recent call last): ..."), "loadProject");
    assert.doesNotMatch(crash.hint!, /Traceback/);
    assert.match(crash.detail!, /Traceback/);
  });

  it("unreachable: a refused connection delivered nothing; a timeout on a write may have", () => {
    const refused = describeError(
      new NeoUnreachable("http://127.0.0.1:8720", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED" } }), "POST", "/api/projects/p1/message"),
      "send",
    );
    assert.equal(refused.summary, "Your message was not sent.");
    assert.equal(refused.maybeDelivered, false);
    assert.equal(refused.offline, true);
    assert.match(refused.hint!, /http:\/\/127\.0\.0\.1:8720.*running/);
    assert.match(refused.detail!, /POST http:\/\/127\.0\.0\.1:8720\/api\/projects\/p1\/message/);
    assert.match(refused.detail!, /ECONNREFUSED/);

    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const unsure = describeError(new NeoUnreachable("http://h:1", timeout, "POST", "/api/projects/p1/gate/approve"), "approve");
    assert.equal(unsure.summary, "NEO did not confirm the approval.");
    assert.equal(unsure.maybeDelivered, true);
    assert.match(unsure.hint!, /may still have been received/);

    // A read is never "maybe delivered": it changes nothing.
    const read = describeError(new NeoUnreachable("http://h:1", timeout, "GET", "/api/projects"), "listProjects");
    assert.equal(read.maybeDelivered, false);
  });

  it("a malformed server URL points at the setting", () => {
    const bad = describeError(new NeoUnreachable("localhost:8720", new TypeError("Failed to parse URL")), "connect");
    assert.equal(bad.config, true);
    assert.match(bad.hint!, /neo\.serverUrl/);
  });

  it("the real client reports a refused connection as not delivered (same on Windows and Linux)", async () => {
    const url = await deadUrl();
    const err = await new NeoClient(url).message("p1", "hi").then(() => null, (e: unknown) => e);
    assert.ok(err instanceof NeoUnreachable);
    assert.equal(err.code, "ECONNREFUSED");
    assert.equal(err.maybeDelivered, false);
    assert.equal(err.config, false);
  });
});

// --- first run and offline ---------------------------------------------------------------------

describe("first run", () => {
  it("NEO offline: the offline state names the configured URL, and no project action is offered as ready", async () => {
    const url = await deadUrl();
    stubState.serverUrl = `${url}/`;            // as typed in the settings, trailing slash and all
    const t = sidebar(tempDir());
    await t.provider.connect();
    const s = t.state()!;
    assert.equal(s.connection, "unreachable");
    assert.equal(s.serverUrl, url, "the configured URL, not a built-in default");
    assert.equal(s.mode, "noProject");
    assert.equal(s.project, undefined);
    assert.equal(s.offline!.summary, "Could not connect to NEO.");
    assert.match(s.offline!.hint!, /running/);
    assert.match(s.offline!.detail!, /ECONNREFUSED/);

    // New Project, Projects and the Web UI from the title bar or the palette explain instead of failing.
    t.provider.showNewProject();
    await t.provider.switchProject();
    t.provider.openInBrowser();
    assert.equal(t.last("showNewProject"), undefined);
    assert.equal(stubState.warnings.length, 3);
    for (const w of stubState.warnings) {
      assert.match(w.text, /NEO is offline/);
      assert.ok(w.text.includes(url));
      assert.deepEqual(w.actions, ["Retry", "Open NEO Settings"]);
    }
  });

  it("Retry after NEO is started connects, and finds the folder is not a NEO project yet", async () => {
    stubState.serverUrl = await deadUrl();
    const folder = tempDir();
    const t = sidebar(folder);
    await t.provider.connect();
    assert.equal(t.state()!.connection, "unreachable");

    const neo = new MockNeo();
    stubState.serverUrl = await neo.listen();
    cleanup.push(() => neo.close());
    await t.send({ type: "retry" });
    const s = t.state()!;
    assert.equal(s.connection, "connected");
    assert.equal(s.offline, undefined);
    assert.equal(s.mode, "noProject", "an open folder that is not a NEO project");
    assert.equal(s.project, undefined, "the header stays NEO: no project name for a plain folder");
    assert.equal(s.folderName, path.basename(folder));
  });

  it("a failed project list says so in the empty state, with its details", async () => {
    const neo = new MockNeo();
    stubState.serverUrl = await neo.listen();
    cleanup.push(() => neo.close());
    const t = sidebar(tempDir());
    // NEO answers its status, then fails the list.
    (neo as unknown as { handle: (req: http.IncomingMessage, res: http.ServerResponse) => void }).handle = (req, res) => {
      if (req.url?.startsWith("/api/debug/status")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ opencode_reachable: true }));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "database is locked" }));
    };
    await t.provider.connect();
    const s = t.state()!;
    assert.equal(s.connection, "connected");
    assert.equal(s.problem!.summary, "Could not load the NEO projects.");
    assert.match(s.problem!.detail!, /HTTP 500[\s\S]*database is locked/);
  });
});

// --- project creation ----------------------------------------------------------------------------

describe("creating a project", () => {
  async function form(answer: { status: number; body: unknown }) {
    const neo = new MockNeo();
    stubState.serverUrl = await neo.listen();
    cleanup.push(() => neo.close());
    neo.createAnswer = answer;
    const folder = path.join(tempDir(), "todo");
    fs.mkdirSync(folder);
    const t = sidebar(folder);
    await t.provider.connect();
    assert.equal(t.state()!.mode, "noProject");
    await t.send({ type: "createProject", name: "todo", idea: "A todo CLI", interaction: "normal" });
    return { ...t, neo };
  }

  it("a duplicate name: a plain message, NEO's own response under details, and no second attempt", async () => {
    const t = await form({ status: 409, body: { detail: "a project named 'todo' already exists" } });
    const failed = t.last("newProjectFailed")!;
    assert.equal(failed.message, "Could not create the NEO project.");
    assert.match(failed.hint!, /already exists/);
    assert.match(failed.detail!, /HTTP 409 · POST \/api\/projects/);
    assert.match(failed.detail!, /a project named 'todo' already exists/);
    assert.equal(mutating(t.neo.calls).length, 1, "created once, never retried");
    assert.equal(t.state()!.connection, "connected");
  });

  it("a folder NEO cannot use: translated, original kept", async () => {
    const t = await form({ status: 422, body: { detail: "/x/todo already exists and is not empty" } });
    const failed = t.last("newProjectFailed")!;
    assert.match(failed.hint!, /not empty/);
    assert.match(failed.detail!, /\/x\/todo already exists and is not empty/);
  });

  it("NEO going away mid-create: the offline state, no retry", async () => {
    const neo = new MockNeo();
    stubState.serverUrl = await neo.listen();
    cleanup.push(() => neo.close());
    const folder = path.join(tempDir(), "todo");
    fs.mkdirSync(folder);
    const t = sidebar(folder);
    await t.provider.connect();
    neo.offline = true;
    await t.send({ type: "createProject", name: "todo", idea: "A todo CLI", interaction: "normal" });
    const failed = t.last("newProjectFailed")!;
    assert.ok(failed.message === "Could not create the NEO project." || failed.message === "NEO did not confirm the new project.");
    assert.equal(t.state()!.connection, "unreachable");
    assert.equal(mutating(neo.calls).length, 1);
  });
});

// --- losing and regaining the connection -----------------------------------------------------------

describe("connection loss with a project open", () => {
  it("Reconnecting… keeps the project and context; three failed reads mean offline; NEO back means Reconnected", async () => {
    const t = await onProject();
    t.neo.offline = true;
    t.neo.drop(t.id);

    await t.internals.resync();
    let s = t.state()!;
    assert.equal(s.connection, "reconnecting");
    assert.equal(s.mode, "project");
    assert.equal(s.project!.id, t.id, "the project stays on screen");
    assert.deepEqual(s.attachments.map((a) => a.id), ["att-1"], "attached context is kept");

    await t.internals.resync();
    assert.equal(t.state()!.connection, "reconnecting");
    await t.internals.resync();
    s = t.state()!;
    assert.equal(s.connection, "unreachable", "offline after three failed reads in a row");
    assert.equal(s.project!.id, t.id);
    assert.equal(s.attachments.length, 1);
    assert.ok(s.offline!.detail);

    t.neo.offline = false;
    await t.internals.resync();
    s = t.state()!;
    assert.equal(s.connection, "connected");
    assert.equal(s.offline, undefined);
    assert.equal(t.posted.filter((m) => m.type === "toast" && m.text === "Reconnected to NEO").length, 1);
    assert.equal(s.attachments.length, 1, "context survives the whole outage");
    assert.equal(mutating(t.neo.calls).length, 0, "recovering reads only");
    // The stream's own backoff reopens it.
    await until(() => t.neo.open(t.id) === 1, "the stream to come back", 8000);
  });

  it("Retry while still offline keeps everything; Retry once NEO is back reloads the same project", async () => {
    const t = await onProject();
    t.neo.offline = true;
    t.neo.drop(t.id);
    const from = t.posted.length;
    await t.send({ type: "retry" });
    let s = t.state()!;
    assert.equal(s.connection, "unreachable", "an explicit Retry that failed says offline at once");
    assert.equal(s.project!.id, t.id);
    assert.equal(s.attachments.length, 1);

    t.neo.offline = false;
    const histories = t.posted.filter((m) => m.type === "history").length;
    await t.send({ type: "retry" });
    await until(() => t.neo.open(t.id) === 1, "the stream after Retry");
    s = t.state()!;
    assert.equal(s.connection, "connected");
    assert.equal(s.mode, "project");
    assert.equal(s.project!.id, t.id);
    assert.equal(s.attachments.length, 1, "Retry does not clear attached context");
    assert.ok(t.posted.filter((m) => m.type === "history").length > histories, "the project was read again");
    const states = t.posted.slice(from).filter((m) => m.type === "state").map((m) => m.state!);
    assert.ok(states.every((st) => st.mode === "project" && st.project?.id === t.id), "the project never left the screen");
    assert.equal(mutating(t.neo.calls).length, 0);
  });

  it("a Refresh that fails while NEO is down still recovers on its own", async () => {
    const t = await onProject();
    t.neo.offline = true;
    t.neo.drop(t.id);
    await t.provider.refresh();
    let s = t.state()!;
    assert.equal(s.mode, "project", "the project is not dropped");
    assert.equal(s.project!.id, t.id);
    assert.notEqual(s.connection, "connected");

    t.neo.offline = false;
    await t.internals.resync();
    await until(() => t.neo.open(t.id) === 1, "the stream reopened by the recovering read");
    s = t.state()!;
    assert.equal(s.connection, "connected");
    assert.equal(s.attachments.length, 1);
  });

  it("a message that cannot be sent keeps its text and is not retried", async () => {
    const t = await onProject();
    t.neo.offline = true;
    await t.send({ type: "send", text: "add a --json flag" });
    const failed = t.last("sendFailed")!;
    assert.equal(failed.text, "add a --json flag");
    assert.equal(failed.message, "Your message was not sent.");
    assert.match(failed.hint!, /not reachable/);
    assert.ok(failed.detail);
    assert.equal(mutating(t.neo.calls).length, 0, "nothing was posted to NEO");
    assert.equal(t.state()!.project!.id, t.id);
    assert.equal(t.state()!.attachments.length, 1, "the chips stay for the next attempt");
  });
});

// --- Done and new sessions -------------------------------------------------------------------------

describe("Done and new sessions under errors", () => {
  it("offline: starting a new session sends nothing and explains why", async () => {
    const t = await onProject({ phase: "done" });
    t.neo.offline = true;
    t.neo.drop(t.id);
    await t.send({ type: "retry" });                // offline now
    const started = await t.provider.startSession("add a health endpoint");
    assert.equal(started, false);
    assert.equal(t.last("sessionStart")!.outcome, "cancelled");
    assert.equal(mutating(t.neo.calls).length, 0, "no POST /sessions");
    assert.match(stubState.warnings.at(-1)!.text, /Starting a new session needs the NEO server/);
  });

  it("a refused new session is translated and not retried; the finished session takes no message", async () => {
    const t = await onProject({ phase: "done" });
    t.neo.projects.get(t.id)!.busy = true;          // NEO refuses: the agent is still working
    stubState.quickPick = (items) => items[0];
    // The provider checks the phase first; this NEO says done and busy at once.
    const started = await t.provider.startSession("add a health endpoint");
    stubState.quickPick = null;
    assert.equal(started, false);
    const failed = t.last("sessionStart")!;
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.message, "Could not start a new session.");
    assert.match(failed.hint!, /still working/);
    assert.equal(mutating(t.neo.calls).filter((c) => c.endsWith("/sessions")).length, 1);
    assert.equal(mutating(t.neo.calls).filter((c) => c.endsWith("/message")).length, 0);

    // A plain send on the completed session is still refused, text kept.
    await t.send({ type: "send", text: "one more thing" });
    assert.match(t.last("sendFailed")!.message!, /This session is complete/);
    assert.equal(mutating(t.neo.calls).filter((c) => c.endsWith("/message")).length, 0);
  });
});

// --- mutating actions wait for a confirmed connection ---------------------------------------------

describe("actions that change NEO wait for Connected", () => {
  /** NEO stops: the stream drops first, and the 10-second read has not failed yet. */
  async function streamDown(t: Awaited<ReturnType<typeof onProject>>) {
    t.neo.offline = true;
    t.neo.drop(t.id);
    await until(() => t.state()!.stream === "reconnecting", "the stream to report reconnecting");
    const s = t.state()!;
    assert.equal(s.connection, "connected", "the window the bug lived in: no read has failed yet");
    assert.equal(s.ready, false, "Reconnecting… is not Connected");
  }

  it("New session (Done) is unavailable while reconnecting, sends nothing, and keeps draft and context", async () => {
    const t = await onProject({ phase: "done" });
    assert.equal(t.state()!.ready, true, "connected and stream up: available");
    await streamDown(t);

    stubState.quickPick = (items) => items[0];
    await t.send({ type: "startSession", text: "add a health endpoint" });
    stubState.quickPick = null;
    assert.equal(t.last("sessionStart")!.outcome, "cancelled");
    assert.match(stubState.warnings.at(-1)!.text, /NEO is reconnecting/);
    assert.equal(mutating(t.neo.calls).length, 0, "no POST /sessions");
    assert.equal(t.state()!.attachments.length, 1);

    // Each later state: unavailable through Reconnecting… and offline.
    for (let i = 0; i < 3; i++) await t.internals.resync();
    assert.equal(t.state()!.connection, "unreachable");
    assert.equal(t.state()!.ready, false);

    // NEO answers again, but until the stream is back the header still says Reconnecting….
    t.neo.offline = false;
    await t.internals.resync();
    const between = t.state()!;
    assert.equal(between.connection, "connected");
    if (between.stream === "reconnecting") assert.equal(between.ready, false, "a good read alone is not Connected");
    await until(() => t.state()!.stream === "up", "the stream to reopen", 20000);
    assert.equal(t.state()!.ready, true, "Connected again: New session is available");
    assert.equal(t.state()!.attachments.length, 1, "context kept throughout");
  });

  it("Send, answer, approve, reject and Stop are refused the same way, with nothing posted", async () => {
    const t = await onProject();
    await streamDown(t);

    await t.send({ type: "send", text: "add a --json flag" });
    const sent = t.last("sendFailed")!;
    assert.equal(sent.text, "add a --json flag", "the text goes back in the box");
    assert.match(sent.message!, /not confirmed/);

    await t.send({ type: "answer", text: "yes" });
    assert.match(t.last("answerFailed")!.message!, /not confirmed/);
    await t.send({ type: "approve" });
    await t.send({ type: "reject", feedback: "smaller please" });
    assert.equal(t.posted.filter((m) => m.type === "gateFailed").length, 2);
    await t.send({ type: "abort" });

    assert.equal(mutating(t.neo.calls).length, 0, "nothing that changes NEO was sent");
    assert.equal(t.state()!.attachments.length, 1);
    assert.equal(t.state()!.project!.id, t.id);
  });

  it("while first connecting, actions are not available either", async () => {
    stubState.serverUrl = await deadUrl();
    const t = sidebar(tempDir());
    const connecting = t.provider.connect();
    const first = t.posted.find((m) => m.type === "state" && m.state!.connection === "connecting");
    assert.equal(first!.state!.ready, false);
    await connecting;
    assert.equal(t.state()!.ready, false);
  });
});
