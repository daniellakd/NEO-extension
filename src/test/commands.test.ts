// NEO's commands: what package.json contributes is what is registered, the view title follows the
// context keys, and every command either acts through the sidebar's own code or says why it cannot.
// The real provider, client and SSE stream against the mock NEO, as in newSession.test.
import { MemoryStore, stubState } from "./vscodeStub";
import { MockNeo } from "./mockNeo";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type * as vscode from "vscode";
import { ChatViewProvider, NeoContextKeys } from "../chatViewProvider";
import { commandTable, registerCommands } from "../commands";
import type { ChangesSnapshot } from "../changes";

const ROOT = path.resolve(__dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  contributes: {
    commands: { command: string; title: string; category?: string; icon?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
    keybindings?: unknown[];
  };
};

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
  state?: { mode: string; phase?: string; busy?: boolean; stopping?: boolean; sessions?: { active?: { id: string } | null } };
}

/** The value a context key was last set to (undefined: never set). */
function key(name: keyof NeoContextKeys): unknown {
  const sets = stubState.commands.filter((c) => c.id === "setContext" && c.args[0] === name);
  return sets.length ? sets[sets.length - 1].args[1] : undefined;
}

/** Run a registered command, as the Command Palette would. */
async function run(id: string): Promise<void> {
  const handler = stubState.registered.get(id);
  assert.ok(handler, `${id} is registered`);
  await handler!();
}

const FULL_STAGES = [
  { phase: "brainstorm", label: "Brainstorm", kind: "work", state: "done" },
  { phase: "design-gate", label: "Design", kind: "gate", state: "done", artifact: "docs/neoag/design.md" },
  { phase: "plan", label: "Planning", kind: "work", state: "done" },
  { phase: "plan-gate", label: "Plan", kind: "gate", state: "done", artifact: "docs/neoag/plan.md" },
  { phase: "execute", label: "Execute", kind: "work", state: "done" },
  { phase: "review-gate", label: "Review", kind: "gate", state: "done", artifact: "docs/neoag/review.md" },
  { phase: "done", label: "Done", kind: "work", state: "active" },
];

interface Setup {
  phase?: string;
  busy?: boolean;
  stages?: Record<string, unknown>[];
  /** No NEO project in the open folder. */
  noProject?: boolean;
  docs?: boolean;
  /** The session's kind (NEO's: full, prd, quick). */
  kind?: string;
}

async function setup(opts: Setup = {}) {
  const neo = new MockNeo();
  stubState.serverUrl = await neo.listen();
  cleanup.push(() => neo.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neo-commands-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  Object.assign(stubState, { quickPick: null, commands: [], focused: true, inputBox: undefined, infos: [], warnings: [] });
  stubState.registered.clear();
  stubState.folders = [root];

  const id = "p1";
  if (!opts.noProject) {
    neo.add({
      id, path: root, name: "todo-api", phase: opts.phase ?? "done", busy: Boolean(opts.busy),
      stages: opts.stages ?? FULL_STAGES,
    });
    neo.startSession(id, { id: "s1", kind: opts.kind ?? "full", title: "Build", request: "A todo API", created_at: 1000 });
    neo.record(id, { kind: "user", note: "kickoff", text: "Build a todo API" });
    neo.record(id, { kind: "phase", phase: opts.phase ?? "done" });
  }
  if (opts.docs !== false) {
    fs.mkdirSync(path.join(root, "docs", "neoag"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "neoag", "design.md"), "# Design\n\n## API\n");
    fs.writeFileSync(path.join(root, "docs", "neoag", "plan.md"), "# Plan\n\n## Task 1: Routes\n- [ ] step\n");
  }

  const vs = require("vscode") as { Uri: { file(p: string): vscode.Uri } };
  const provider = new ChatViewProvider(vs.Uri.file(ROOT), new MemoryStore() as unknown as vscode.Memento);
  cleanup.push(() => provider.dispose());
  const disposables = registerCommands(provider);
  cleanup.push(() => disposables.forEach((d) => d.dispose()));
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
  if (opts.noProject) await until(() => state()?.mode === "noProject", "no project");
  else await until(() => Boolean(state()?.sessions?.active), "the session view");
  return { neo, id, root, provider, posted, state };
}

const writes = (neo: MockNeo, from = 0) => neo.calls.slice(from).filter((c) => !c.startsWith("GET "));

// --- the manifest and the registrations -----------------------------------------------------

describe("command registration", () => {
  const contributed = manifest.contributes.commands.map((c) => c.command);
  const table = Object.keys(commandTable({} as never));

  it("every contributed command is registered, and nothing is registered that is not contributed", () => {
    assert.deepEqual([...table].sort(), [...contributed].sort());
    stubState.registered.clear();
    const disposables = registerCommands({} as never);
    assert.deepEqual([...stubState.registered.keys()].sort(), [...contributed].sort());
    disposables.forEach((d) => d.dispose());
    assert.equal(stubState.registered.size, 0);
  });

  it("no command id is contributed twice, and every one is in the NEO category", () => {
    assert.equal(new Set(contributed).size, contributed.length);
    for (const c of manifest.contributes.commands) assert.equal(c.category, "NEO", c.command);
  });

  it("the new navigation commands exist, and Open in Browser is titled Open Web UI under its old id", () => {
    const title = (id: string) => manifest.contributes.commands.find((c) => c.command === id)?.title;
    assert.equal(title("neo.openInBrowser"), "Open Web UI");
    assert.equal(title("neo.stop"), "Stop Current Work");
    assert.equal(title("neo.openDesign"), "Open Design");
    assert.equal(title("neo.openPlan"), "Open Plan");
    assert.equal(title("neo.openChanges"), "Open Current Changes");
    assert.equal(title("neo.goTo"), "Go to…");
    assert.equal(title("neo.openSettings"), "Open Settings");
  });

  it("menus only name contributed commands, and no global keybinding is added", () => {
    for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
      for (const e of entries) assert.ok(contributed.includes(e.command), `${menu}: ${e.command}`);
    }
    assert.equal(manifest.contributes.keybindings, undefined);
  });

  it("the view title: few icons, each shown by state, every icon with a title for its tooltip", () => {
    const title = manifest.contributes.menus["view/title"];
    for (const e of title) assert.match(e.when ?? "", /^view == neo\.chat\b/, e.command);
    const visible = title.filter((e) => e.group?.startsWith("navigation"));
    const when = (id: string) => visible.find((e) => e.command === id)?.when;
    assert.match(when("neo.stop")!, /neo\.busy/);
    assert.match(when("neo.startSession")!, /neo\.sessionDone/);
    assert.match(when("neo.newProject")!, /!neo\.hasProject/);
    assert.match(when("neo.sessions")!, /(?<!!)neo\.hasProject/);
    assert.ok(when("neo.switchProject"));
    assert.equal(when("neo.refresh"), undefined, "Refresh is in the overflow");
    assert.equal(when("neo.openInBrowser"), undefined, "Web UI is in the overflow");
    // At most three icons at once: (Stop | New Session) + Sessions + Projects, or New Project + Projects.
    assert.equal(visible.length, 5);
    for (const e of visible) {
      const c = manifest.contributes.commands.find((x) => x.command === e.command)!;
      assert.ok(c.icon && c.title.length > 3, `${e.command} has an icon and a readable title`);
    }
    // New Project is still reachable from the overflow once a project is open.
    assert.ok(title.some((e) => e.command === "neo.newProject" && !e.group?.startsWith("navigation") && /neo\.hasProject/.test(e.when!)));
    // Stop and New Session no longer share New Project's icon in the visible bar at the same time.
    const icon = (id: string) => manifest.contributes.commands.find((c) => c.command === id)!.icon;
    assert.notEqual(icon("neo.stop"), icon("neo.startSession"));
  });
});

// --- context keys -----------------------------------------------------------------------------

describe("context keys follow the sidebar", () => {
  it("no NEO project: none set true", async () => {
    await setup({ noProject: true });
    assert.equal(key("neo.hasProject"), false);
    assert.equal(key("neo.busy"), false);
    assert.equal(key("neo.sessionDone"), false);
  });

  it("work running: busy, not done; Stop clears busy once NEO reports the turn ended", async () => {
    const t = await setup({ phase: "execute", busy: true });
    assert.equal(key("neo.hasProject"), true);
    assert.equal(key("neo.busy"), true);
    assert.equal(key("neo.sessionDone"), false);
    await run("neo.stop");
    assert.equal(key("neo.busy"), false, "hidden while stopping");
    await until(() => t.state()?.busy === false && t.state()?.stopping === false, "the stop to settle");
    assert.equal(key("neo.busy"), false);
    assert.equal(key("neo.sessionDone"), false, "execute is not Done");
  });

  it("Done: a new session can start; once it has, it no longer can", async () => {
    const t = await setup();
    assert.equal(key("neo.sessionDone"), true);
    stubState.inputBox = "Add a health endpoint";
    stubState.quickPick = (items) => (items as { sessionKind?: string }[]).find((i) => i.sessionKind === "quick");
    await run("neo.startSession");
    await until(() => t.state()?.phase === "execute", "the new session");
    assert.equal(key("neo.sessionDone"), false);
    assert.equal(key("neo.hasProject"), true);
  });

  it("switching project and losing NEO update them", async () => {
    const t = await setup();
    t.neo.add({ id: "p2", path: path.join(t.root, "other"), name: "other", phase: "execute", busy: true });
    t.neo.startSession("p2", { id: "o1", kind: "full", title: "Other", created_at: 1000 });
    stubState.quickPick = (items) => (items as { id?: string }[]).find((i) => i.id === "p2");
    await run("neo.switchProject");
    await until(() => key("neo.busy") === true, "the busy project");
    assert.equal(key("neo.sessionDone"), false);

    await t.neo.close();
    await run("neo.connect");
    await until(() => key("neo.hasProject") === false, "the project to go");
    assert.equal(key("neo.busy"), false);
    assert.equal(key("neo.sessionDone"), false);
  });

  it("each key is only set when it changes", async () => {
    const t = await setup();
    const before = stubState.commands.filter((c) => c.id === "setContext").length;
    await (t.provider as unknown as { resync(): Promise<void> }).resync();
    await (t.provider as unknown as { resync(): Promise<void> }).resync();
    assert.equal(stubState.commands.filter((c) => c.id === "setContext").length, before);
  });
});

// --- without a project ------------------------------------------------------------------------

describe("commands with no NEO project", () => {
  it("each says to open a project first, instead of failing silently", async () => {
    const t = await setup({ noProject: true });
    for (const id of ["neo.stop", "neo.openDesign", "neo.openPlan", "neo.openChanges", "neo.goTo", "neo.sessions", "neo.startSession"]) {
      stubState.infos = [];
      await run(id);
      assert.equal(stubState.infos.length, 1, id);
      assert.match(stubState.infos[0], /open a NEO project first/, id);
    }
    assert.deepEqual(writes(t.neo), [], "nothing was sent to NEO");
  });

  it("Open Settings opens VS Code's Settings on this extension", async () => {
    await setup({ noProject: true });
    await run("neo.openSettings");
    const c = stubState.commands.find((x) => x.id === "workbench.action.openSettings");
    assert.deepEqual(c?.args, ["@ext:neoag.neo-vscode"]);
  });
});

// --- Stop -------------------------------------------------------------------------------------

describe("Stop Current Work", () => {
  it("idle: says nothing is running and sends no abort", async () => {
    const t = await setup({ phase: "execute" });
    await run("neo.stop");
    assert.match(stubState.infos.join("\n"), /nothing is running on todo-api/);
    assert.ok(!t.neo.calls.some((c) => c.endsWith("/abort")));
  });

  it("running: NEO's own abort, once, with the chat shown; a second Stop says it is already stopping", async () => {
    const t = await setup({ phase: "execute", busy: true });
    await run("neo.stop");
    assert.equal(t.neo.calls.filter((c) => c.endsWith("/abort")).length, 1);
    assert.ok(stubState.commands.some((c) => c.id === "neo.chat.focus"));
    // NEO reports the turn ended 100 ms after the abort (the mock, as NEO does): still stopping now.
    assert.equal(t.state()?.stopping, true);
    await run("neo.stop");
    assert.match(stubState.infos.join("\n"), /already stopping/);
    assert.equal(t.neo.calls.filter((c) => c.endsWith("/abort")).length, 1);
  });
});

// --- Design and Plan --------------------------------------------------------------------------

describe("Open Design / Open Plan", () => {
  const previewed = () =>
    stubState.commands.filter((c) => c.id === "markdown.showPreview").map((c) => (c.args[0] as vscode.Uri).fsPath);

  it("open the current session's documents as the read-only Markdown preview, changing nothing", async () => {
    const t = await setup();
    const calls = t.neo.calls.length;
    await run("neo.openDesign");
    await run("neo.openPlan");
    assert.deepEqual(previewed(), [
      path.join(t.root, "docs", "neoag", "design.md"),
      path.join(t.root, "docs", "neoag", "plan.md"),
    ]);
    assert.deepEqual(writes(t.neo, calls), []);
    assert.equal(t.state()?.sessions?.active?.id, "s1");
  });

  it("a session without those steps (a quick change) says so", async () => {
    await setup({ kind: "quick", phase: "execute", stages: [{ phase: "execute", label: "Execute", kind: "work", state: "active" }] });
    await run("neo.openPlan");
    await run("neo.openDesign");
    assert.match(stubState.infos[0], /has no plan: it is a Quick change session, which does not go through a plan step/);
    assert.match(stubState.infos[1], /has no design: it is a Quick change session/);
    assert.deepEqual(previewed(), []);
  });

  it("a plan not written yet says so, rather than opening nothing silently", async () => {
    await setup({
      phase: "design-gate",
      stages: [
        { phase: "design-gate", label: "Design", kind: "gate", state: "active", artifact: "docs/neoag/design.md" },
        { phase: "plan", label: "Planning", kind: "work", state: "pending" },
        { phase: "plan-gate", label: "Plan", kind: "gate", state: "pending", artifact: "docs/neoag/plan.md" },
      ],
    });
    await run("neo.openPlan");
    assert.match(stubState.infos.join("\n"), /no plan yet/);
    await run("neo.openDesign");
    assert.equal(previewed().length, 1, "the design at its gate opens");
  });

  it("a document missing on disk is reported", async () => {
    await setup({ docs: false });
    await run("neo.openDesign");
    assert.match(stubState.infos.join("\n"), /Design \(docs\/neoag\/design\.md\) was not found/);
  });
});

// --- Changes ----------------------------------------------------------------------------------

describe("Open Current Changes", () => {
  it("before Execute: says there are no changes yet", async () => {
    await setup({ phase: "design-gate" });
    await run("neo.openChanges");
    assert.match(stubState.infos.join("\n"), /no changes yet on todo-api/);
  });

  it("lists the Changes strip's files; the one picked opens the native diff", async () => {
    const t = await setup();
    type C = { snapshot: ChangesSnapshot | null; running: boolean };
    const changes = (t.provider as unknown as { changes: C }).changes;
    await until(() => !changes.running && changes.snapshot !== null, "the first read of the changes");
    changes.snapshot = {
      project: t.root, source: "merged", label: "main ↔ merge", additions: 3, deletions: 1, truncated: false,
      files: [{ path: "src/app.py", status: "M", additions: 3, deletions: 1 }],
      repo: t.root, baseRef: "a".repeat(40), baseName: "main before", targetRef: "b".repeat(40), targetName: "merge",
    };
    let offered: { label?: string; description?: string }[] = [];
    stubState.quickPick = (items) => {
      offered = items as typeof offered;
      return items[0];
    };
    await run("neo.openChanges");
    assert.equal(offered[0].label, "app.py");
    assert.equal(offered[0].description, "M · +3 −1");
    const diff = stubState.commands.find((c) => c.id === "vscode.diff");
    assert.ok(diff, "the diff opened");
    assert.match(String(diff!.args[2]), /app\.py/);
  });

  it("an unreadable change list is a warning, not silence", async () => {
    const t = await setup();
    const changes = (t.provider as unknown as { changes: { snapshot: ChangesSnapshot | null; running: boolean } }).changes;
    await until(() => !changes.running && changes.snapshot !== null, "the first read of the changes");
    // The temp folder is not a git repository: the controller reports that.
    await run("neo.openChanges");
    assert.deepEqual(stubState.infos, []);
    assert.equal(stubState.warnings.length, 1);
    assert.match(stubState.warnings[0], /^NEO: could not read the changes: /);
  });
});

// --- Go to, and Sessions ----------------------------------------------------------------------

describe("Go to… and Sessions", () => {
  it("Go to lists the current session, its documents and Sessions; Current session shows the chat", async () => {
    await setup();
    let offered: { label?: string }[] = [];
    stubState.quickPick = (items) => {
      offered = items as typeof offered;
      return items[0];
    };
    await run("neo.goTo");
    const labels = offered.map((i) => i.label);
    assert.equal(labels[0], "$(comment-discussion) Current session");
    assert.ok(labels.includes("$(book) Design"));
    assert.ok(labels.includes("$(checklist) Plan"));
    assert.ok(labels.includes("$(diff) Changes"));
    assert.equal(labels[labels.length - 1], "$(history) Sessions");
    assert.ok(stubState.commands.some((c) => c.id === "neo.chat.focus"));
  });

  it("Sessions opens an earlier session as a read-only snapshot; the current session is unchanged", async () => {
    const t = await setup();
    stubState.inputBox = "Add a health endpoint";
    stubState.quickPick = (items) => (items as { sessionKind?: string }[]).find((i) => i.sessionKind === "full");
    await run("neo.startSession");
    await until(() => t.state()?.sessions?.active?.id === "s2-new", "the new session");
    const calls = t.neo.calls.length;

    stubState.quickPick = (items) => (items as { id?: string }[]).find((i) => i.id === "s1");
    await run("neo.sessions");
    const open = stubState.commands.filter((c) => c.id === "markdown.showPreview").pop();
    const uri = open!.args[0] as vscode.Uri;
    assert.equal(uri.scheme, "neo-session");
    assert.equal(new URLSearchParams(uri.query).get("session"), "s1");
    assert.deepEqual(writes(t.neo, calls), [], "viewing writes nothing");
    assert.equal(t.state()?.sessions?.active?.id, "s2-new");
  });

  it("New Session while work is still in progress says so and starts nothing", async () => {
    const t = await setup({ phase: "execute" });
    await run("neo.startSession");
    assert.match(stubState.infos.join("\n"), /still in progress \(execute\)/);
    assert.equal(t.neo.posts.length, 0);
  });
});
