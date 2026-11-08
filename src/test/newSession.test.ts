// New work on a finished project: a new NEO session (POST /sessions), never a message into the
// completed one. The real provider, client and SSE stream against the mock NEO, as in sessions.test.
import { MemoryStore, stubState } from "./vscodeStub";
import { MockNeo } from "./mockNeo";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type * as vscode from "vscode";
import { ChatViewProvider } from "../chatViewProvider";
import { sessionState, sessionStateLabel } from "../sessionHistory";
import type { SessionsController, SessionsView } from "../sessions";

const HEALTH = 'Add a GET /health endpoint that returns {"status":"ok"}.';

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

interface Posted {
  type: string;
  outcome?: string;
  text?: string;
  message?: string;
  events?: { kind: string; text?: string }[];
  state?: { mode: string; phase?: string; sessions?: SessionsView };
}

type Internals = {
  resync(): Promise<void>;
  send(text: string): Promise<void>;
  onMessage(m: { type: string; [k: string]: unknown }): Promise<void>;
  sessions: SessionsController;
};

/** A NEO with one project whose build (Build 1, full pipeline) has reached Done. */
function neoWithDoneBuild(neo: MockNeo, root: string, opts: { phase?: string } = {}) {
  const id = "p1";
  neo.add({ id, path: root, name: "todo-api", busy: false, phase: opts.phase ?? "done" });
  neo.startSession(id, { id: "s1", kind: "full", title: "Build", request: "A todo API", created_at: 1000 });
  neo.record(id, { kind: "user", note: "kickoff", text: "Build a todo API" });
  for (const phase of ["design-gate", "plan", "plan-gate", "execute", "review", "review-gate", "finish"]) {
    neo.record(id, { kind: "phase", phase });
  }
  neo.record(id, { kind: "text", part: "a", text: "Merged work/todo-api into main.", replace: true });
  if ((opts.phase ?? "done") === "done") neo.record(id, { kind: "phase", phase: "done" });
  return id;
}

/** A sidebar on that project. `store` carries over between windows, as globalState does. */
async function open(neo: MockNeo, root: string, store: MemoryStore) {
  stubState.folders = [root];
  const vs = require("vscode") as { Uri: { file(p: string): vscode.Uri } };
  const provider = new ChatViewProvider(vs.Uri.file(path.resolve(__dirname, "..", "..")), store as unknown as vscode.Memento);
  cleanup.push(() => provider.dispose());
  const posted: Posted[] = [];
  const view = {
    visible: true,
    webview: {
      options: {}, html: "", cspSource: "vscode-resource:", asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (m: Posted) => { posted.push(JSON.parse(JSON.stringify(m))); return true; },
    },
    onDidDispose: () => ({ dispose() {} }),
    onDidChangeVisibility: () => ({ dispose() {} }),
  };
  provider.resolveWebviewView(view as unknown as vscode.WebviewView);
  await provider.connect();
  const state = () => [...posted].reverse().find((m) => m.type === "state")?.state;
  await until(() => Boolean(state()?.sessions?.active), "the session view");
  return { provider, posted, state, sessions: () => state()!.sessions!, internals: provider as unknown as Internals };
}

async function setup(opts: { phase?: string } = {}) {
  const neo = new MockNeo();
  stubState.serverUrl = await neo.listen();
  cleanup.push(() => neo.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neo-newsession-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  stubState.quickPick = null;
  stubState.commands = [];
  stubState.focused = true;
  stubState.inputBox = undefined;
  stubState.infos = [];
  const id = neoWithDoneBuild(neo, root, opts);
  const store = new MemoryStore();
  const t = await open(neo, root, store);
  return { neo, id, root, store, ...t };
}

/** Pick a session kind in NEO's own kind picker. */
function choose(kind: string | null) {
  stubState.quickPick = (items) => (kind === null ? undefined : (items as { sessionKind?: string }[]).find((i) => i.sessionKind === kind));
}

const textsOf = (neo: MockNeo, id: string, session: string) =>
  neo.projects.get(id)!.history.filter((e) => e.__session === session).map((e) => String(e.text ?? e.phase ?? ""));

describe("a session's state, from what NEO reports", () => {
  it("the current session: completed at Done, running, waiting for you, otherwise in progress", () => {
    assert.equal(sessionState({ current: true, endedAt: null, phase: "done" }), "completed");
    assert.equal(sessionState({ current: true, endedAt: null, phase: "execute", busy: true }), "running");
    assert.equal(sessionState({ current: true, endedAt: null, phase: "plan-gate", waiting: true }), "waiting for you");
    assert.equal(sessionState({ current: true, endedAt: null, phase: "execute" }), "in progress");
    assert.equal(sessionStateLabel("completed", true), "completed · current");
  });

  it("an earlier session: completed only when NEO recorded it reaching Done, otherwise ended", () => {
    assert.equal(sessionState({ current: false, endedAt: 5, reachedDone: true }), "completed");
    assert.equal(sessionState({ current: false, endedAt: 5, reachedDone: false }), "ended");
    assert.equal(sessionState({ current: false, endedAt: 5 }), "ended");      // not looked up yet: no claim
    assert.equal(sessionStateLabel("ended", false), "ended");
  });
});

describe("a project whose build is done", () => {
  it("says so: the build is 'completed · current', not 'active'", async () => {
    const t = await setup();
    const v = t.sessions();
    assert.equal(v.list.length, 1);
    assert.equal(v.active!.id, "s1");
    assert.equal(v.active!.state, "completed");
    let offered: { description?: string }[] = [];
    stubState.quickPick = (items) => void (offered = items as typeof offered);
    await t.provider.showSessions();
    assert.match(offered.map((i) => i.description).join("\n"), /1 of 1 · Full pipeline · completed · current/);
    assert.ok(!offered.some((i) => /\bactive\b/.test(i.description ?? "")));
  });

  it("a message after Done is not sent into the completed session; the text is kept", async () => {
    const t = await setup();
    const before = textsOf(t.neo, t.id, "s1").length;
    await t.internals.send("Add a health endpoint");
    assert.ok(!t.neo.calls.some((c) => c.startsWith("POST") && c.includes("/message")), "no POST /message");
    const failed = t.posted.filter((m) => m.type === "sendFailed").pop()!;
    assert.equal(failed.text, "Add a health endpoint");
    assert.match(failed.message!, /complete/);
    assert.equal(textsOf(t.neo, t.id, "s1").length, before, "Build 1 is untouched");
    assert.equal(t.neo.projects.get(t.id)!.sessions!.length, 1, "and no session was made behind the user's back");
  });
});

describe("starting new work", () => {
  it("creates Build 2, makes it current, and leaves Build 1 stored and ended", async () => {
    const t = await setup();
    const build1 = textsOf(t.neo, t.id, "s1");
    choose("full");
    assert.equal(await t.provider.startSession(HEALTH), true);

    // Build 2: NEO's POST /sessions, with the request and the kind chosen.
    const post = t.neo.posts.find((p) => p.path === "/sessions")!;
    assert.deepEqual(post.body, { kind: "full", request: HEALTH });
    const sessions = t.neo.projects.get(t.id)!.sessions!;
    assert.equal(sessions.length, 2);
    const build2 = sessions[1].id as string;

    // Build 1 is still stored, word for word, and ended.
    assert.deepEqual(textsOf(t.neo, t.id, "s1"), build1);
    assert.ok(sessions[0].ended_at, "Build 1 ended when Build 2 started");

    // The sidebar is on Build 2: its own history, with Build 1's not mixed in.
    await until(() => t.sessions().active?.id === build2, "Build 2 current");
    const history = t.posted.filter((m) => m.type === "history").pop()!;
    const said = (history.events ?? []).map((e) => e.text ?? "").join("\n");
    assert.match(said, /GET \/health/);
    assert.ok(!said.includes("Merged work/todo-api"), "Build 1's transcript is not in Build 2's");
    assert.equal(t.state()!.phase, "brainstorm", "a full pipeline starts at the interview");
    assert.equal(t.posted.filter((m) => m.type === "sessionStart").pop()!.outcome, "started");
  });

  it("the sessions list has both: Build 1 completed, Build 2 current", async () => {
    const t = await setup();
    choose("full");
    await t.provider.startSession(HEALTH);
    await until(() => t.sessions().list.length === 2 && t.sessions().list[0].state === "completed", "both builds, Build 1 looked up");
    const [b1, b2] = t.sessions().list;
    assert.deepEqual([b1.index, b1.count, b1.active, b1.state], [1, 2, false, "completed"]);
    assert.deepEqual([b2.index, b2.count, b2.active], [2, 2, true]);
    assert.notEqual(b2.state, "completed");

    let offered: { id?: string; description?: string }[] = [];
    stubState.quickPick = (items) => void (offered = items as typeof offered);
    await t.provider.showSessions();
    assert.match(offered[0].description!, /^2 of 2 · Full pipeline · (in progress|running|waiting for you) · current$/);
    assert.equal(offered[1].description, "1 of 2 · Full pipeline · completed");
  });

  it("reopening VS Code restores Build 2 as current", async () => {
    const t = await setup();
    choose("full");
    await t.provider.startSession(HEALTH);
    const build2 = t.neo.projects.get(t.id)!.sessions![1].id;
    t.provider.dispose();

    const again = await open(t.neo, t.root, t.store);              // a new window, same globalState
    assert.equal(again.sessions().active!.id, build2);
    const history = again.posted.filter((m) => m.type === "history").pop()!;
    assert.match((history.events ?? []).map((e) => e.text ?? "").join("\n"), /GET \/health/);
  });

  it("opening Build 1's snapshot is read-only and leaves Build 2 current", async () => {
    const t = await setup();
    choose("full");
    await t.provider.startSession(HEALTH);
    const build2 = t.neo.projects.get(t.id)!.sessions![1].id;
    await until(() => t.sessions().active?.id === build2, "Build 2 current");
    const calls = t.neo.calls.length;

    const md = await t.internals.sessions.document({ query: new URLSearchParams({ project: t.id, session: "s1" }).toString() } as vscode.Uri);
    assert.match(md, /^# Build\n/);
    assert.match(md, /\| Status \| Completed \|/);
    assert.match(md, /Merged work\/todo-api/);
    assert.ok(!md.includes("GET /health"), "only Build 1's events");

    const during = t.neo.calls.slice(calls);
    assert.ok(during.every((c) => c.startsWith("GET ")), `only reads: ${during.join(", ")}`);
    await t.internals.resync();
    assert.equal(t.sessions().active!.id, build2);
    assert.equal(t.neo.projects.get(t.id)!.sessions!.length, 2);
    assert.equal(t.neo.projects.get(t.id)!.phase, "brainstorm", "Build 2's phase is unchanged");
  });

  it("from the message box: the webview's request goes the same way, and its text is not echoed into Build 1", async () => {
    const t = await setup();
    choose("quick");
    await t.internals.onMessage({ type: "startSession", text: HEALTH });
    await until(() => t.neo.projects.get(t.id)!.sessions!.length === 2, "Build 2");
    assert.equal(t.neo.posts[0].body.kind, "quick");
    assert.ok(!t.neo.calls.some((c) => c.includes("/message")));
    assert.ok(!textsOf(t.neo, t.id, "s1").some((x) => x.includes("/health")));
  });

  it("from the command or the Sessions picker: the request is asked for", async () => {
    const t = await setup();
    stubState.inputBox = HEALTH;
    choose("prd");
    assert.equal(await t.provider.startSession(), true);
    assert.deepEqual(t.neo.posts[0].body, { kind: "prd", request: HEALTH });
  });

  it("cancelling the choice of pipeline starts nothing and keeps the text", async () => {
    const t = await setup();
    choose(null);
    assert.equal(await t.provider.startSession(HEALTH), false);
    assert.ok(!t.neo.calls.some((c) => c.startsWith("POST")));
    assert.equal(t.posted.filter((m) => m.type === "sessionStart").pop()!.outcome, "cancelled");
    assert.equal(t.neo.projects.get(t.id)!.sessions!.length, 1);
  });
});

describe("what does not change", () => {
  it("a session still in progress: messages go to it, and no new session can be started over it", async () => {
    const t = await setup({ phase: "execute" });
    assert.equal(t.sessions().active!.state, "in progress");
    await t.internals.send("Use SQLite instead.");
    assert.ok(t.neo.calls.some((c) => c.startsWith("POST") && c.includes("/message")), "an ordinary message");
    choose("full");
    assert.equal(await t.provider.startSession(HEALTH), false);
    assert.ok(!t.neo.calls.some((c) => c.startsWith("POST") && c.endsWith("/sessions")));
    assert.match(stubState.infos.pop()!, /still in progress/);
    assert.equal(t.neo.projects.get(t.id)!.sessions!.length, 1);
  });

  it("since you were away: reopening after Build 2 started says Build 1 ended", async () => {
    const t = await setup();
    // The user saw Build 1 at Done; the anchor is written when the transcript is on screen.
    await until(() => t.store.keys().some((k) => k.startsWith("neo.sessions.seen:")), "the anchor");
    t.provider.dispose();

    // Build 2 is started while the window is closed (from the web UI, say).
    t.neo.projects.get(t.id)!.phase = "brainstorm";
    t.neo.startSession(t.id, { id: "s2", kind: "full", title: "Health endpoint", request: HEALTH });
    t.neo.record(t.id, { kind: "phase", phase: "brainstorm" });

    const again = await open(t.neo, t.root, t.store);
    await until(() => Boolean(again.sessions().away), "the card");
    const away = again.sessions().away!;
    const items = (away.items ?? []).map((i) => i.text).join("\n");
    assert.match(items, /Session “Build” ended/);
    assert.match(items, /New session started: “Health endpoint” \(Full pipeline\)/);
    assert.equal(again.sessions().active!.id, "s2");
  });
});
