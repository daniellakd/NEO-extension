import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  Gate,
  NeoClient,
  NeoEvent,
  NeoHttpError,
  NeoUnreachable,
  ProjectDetail,
  SessionKind,
  Stage,
  hostOf,
} from "./neoClient";
import {
  Attachment,
  AttachmentView,
  ContextError,
  MAX_ITEMS,
  composeMessage,
  fileAttachment,
  labelOf,
  pickWorkspaceFile,
  sameTarget,
  selectedLines,
  selectionAttachment,
  viewOf,
} from "./context";
import {
  ActionTracker,
  HeldNotice,
  LiveView,
  PlanTracker,
  buildLive,
  liveNotice,
  noticeOf,
  stopExplains,
  touchesPlan,
} from "./progress";
import { ChangesController, ChangesMessage, changesPhase } from "./changes";
import { ArtifactView, ArtifactsView, PlanArtifacts, PlanMessage, StageLike } from "./plan";
import { kindLabel, sessionStateLabel } from "./sessionHistory";
import { SessionsController, SessionsMessage, SessionsView } from "./sessions";
import { SseStream } from "./sseStream";
import { ErrorAction, ErrorView, OPEN_SETTINGS, describeError, logError, notifyError, openSettings } from "./errors";
import { currentFolder, neoSlug, normalizePath, projectForFolder, samePath } from "./workspace";

/**
 * The sidebar: one webview, one NEO project (the one living in the open folder).
 *
 * Everything that is a decision — which phase, which gate, whether checks pass — comes from NEO.
 * This class holds a *copy* of NEO's state for display, refreshed from three sources:
 *   1. the project read (`GET /api/projects/{id}`) on load, after every stream (re)open, and every
 *      10 seconds;
 *   2. the SSE stream, for live output;
 *   3. the answers to the user's own actions (approve returns the new phase, and so on).
 */

const HISTORY = 200;
const RESYNC_MS = 10_000;
// The webview's transcript is rebuilt from this if it reloads. Bounded so a long run cannot grow
// the extension host without limit.
const TRANSCRIPT_CAP = 4_000;
// Kinds the MVP does not draw. They are not forwarded at all, which also keeps chatty
// `reasoning`/`usage` deltas off the webview channel.
const IGNORED_KINDS = new Set(["hello", "usage", "reasoning", "permission", "signal"]);
// How long the sidebar waits for NEO to report the aborted turn ending before it stops saying
// "stopping". NEO's abort semantics are unchanged; this is only what the panel shows.
const STOP_SETTLE_MS = 30_000;
// NEO's POST /sessions takes a request of at most this many characters (app.py SessionIn).
const SESSION_REQUEST_MAX = 20_000;
// Consecutive failed reads of an open project before "Reconnecting…" becomes "NEO is offline". The
// reads keep going either way (the 10-second resync and the stream's own backoff).
const OFFLINE_AFTER = 3;
const DONE_REFUSAL =
  "This session is complete, so the message was not sent into it. Press Send again to start a new " +
  "session with it - the completed one stays as read-only history.";

type Connection = "connecting" | "connected" | "reconnecting" | "unreachable";

/**
 * Context keys for the view title's state-dependent actions (package.json `when` clauses). Only the
 * title bar uses them; every command stays in the Command Palette and says why when it cannot act.
 */
export interface NeoContextKeys {
  /** A NEO project is shown in the sidebar. */
  "neo.hasProject": boolean;
  /** NEO is running a turn on it that Stop can end (and no Stop is already under way). */
  "neo.busy": boolean;
  /** Its current session reached Done, so a new session can start. */
  "neo.sessionDone": boolean;
}

/** An error as the webview shows it: the summary, what to do, and the technical detail behind a toggle. */
interface Problem {
  summary: string;
  hint?: string;
  detail?: string;
  /** The server URL setting is the likely cause: offer the settings first. */
  config?: boolean;
}
type Mode = "loading" | "noFolder" | "noProject" | "project";

interface ViewState {
  serverHost: string;
  /** The configured `neo.serverUrl`, as the user wrote it (normalised). */
  serverUrl: string;
  connection: Connection;
  /** Why NEO is not reachable, while it is not. */
  offline?: Problem;
  /** A failed read with nothing on screen to keep (no project): shown in the empty state with Retry. */
  problem?: Problem;
  /** An explicit Retry is in flight. */
  retrying: boolean;
  /**
   * NEO is confirmed reachable: connected, and the live stream not dropped. Exactly when the header
   * says "Connected". Actions that change NEO's state (send, new session, answer, gate,
   * stop) are enabled only then; the draft and the attached context are untouched either way.
   */
  ready: boolean;
  runtimeReachable?: boolean;
  stream: "off" | "up" | "reconnecting";
  folder?: string;
  folderName?: string;
  mode: Mode;
  // `idea` is the user's own request, so the webview can show it apart from the kickoff prompt
  // NEO wraps around it.
  project?: { id: string; name: string; path: string; idea?: string };
  phase?: string;
  stages: Stage[];
  busy: boolean;
  atGate: boolean;
  gate: Gate | null;
  awaiting: boolean;
  pendingRequest: string | null;
  needsAttention: boolean;
  attentionReason: string | null;
  planProgress: { done: number; total: number } | null;
  // Live progress. Everything below is derived from what NEO already reports; see src/progress.ts.
  stopping: boolean;
  stoppedAt?: number;
  /** The user's Stop ended the last turn and nothing has started since (see buildLive). */
  userStopped: boolean;
  streamRetryAt?: number;
  catchingUp: boolean;
  live?: LiveView;
  // The Design and Plan documents and where each stands (src/plan.ts).
  artifacts?: ArtifactsView;
  // Which NEO session is active, the earlier ones, and what happened while the user was away (src/sessions.ts).
  sessions?: SessionsView;
  // Context the next message carries, and the one-click offer of the editor the user is in.
  attachments: AttachmentView[];
  suggestion: { kind: "file" | "selection"; label: string } | null;
}

/** Where an attach request came from: the + menu, the suggested chip, or "@" typed in the input. */
type ContextSource = "menu" | "suggested" | "at" | "file" | "selection";

/** Messages the webview sends. */
type Inbound =
  | { type: "ready" }
  | { type: "connect" }
  | { type: "retry" }
  | { type: "openSettings" }
  | { type: "pickFolder" }
  | { type: "refresh" }
  | { type: "createProject"; name: string; idea: string; interaction: string }
  | { type: "send"; text: string }
  | { type: "answer"; request?: string; text?: string; answers?: string[] }
  | { type: "approve"; reason?: string }
  | { type: "reject"; feedback: string }
  | { type: "abort" }
  | { type: "openBrowser" }
  | { type: "newProject" }
  | { type: "switchProject" }
  | { type: "openFolder"; path: string }
  | { type: "addContext"; source: ContextSource }
  | { type: "removeContext"; id: string }
  | { type: "startSession"; text: string };

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = "neo.chat";

  private view: vscode.WebviewView | undefined;
  private client: NeoClient;
  private stream: SseStream | undefined;
  private resyncTimer: NodeJS.Timeout | undefined;
  private state: ViewState;

  // Stream bookkeeping. `lastSeq` is the newest persisted event already delivered; anything at or
  // below it is a duplicate, whichever path it came by.
  private lastSeq = 0;
  private filling = false;
  private held: NeoEvent[] = [];
  private transcript: NeoEvent[] = [];
  private outbox: NeoEvent[] = [];
  private flushTimer: NodeJS.Timeout | undefined;

  // Incremented whenever the project (or connection) changes, so a slow reply for the old one is
  // dropped instead of drawn over the new one.
  private generation = 0;
  private resyncSeq = 0;
  private resyncApplied = 0;
  private resyncing = false;
  // Consecutive failed reads; see OFFLINE_AFTER. And, with no project open, the slow check for NEO
  // coming up, so a first run connects on its own once the server is started.
  private failures = 0;
  private offlineTimer: NodeJS.Timeout | undefined;
  // A reload of the open project failed, so it has no stream: the next good read reloads it.
  private orphaned = false;

  // Attached context lives here, not in the webview: a selection is a snapshot only the host can
  // take, and the chips survive the webview reloading.
  private attachments: Attachment[] = [];

  // Live progress. The plan is remembered per project; the action and the notice are whatever the
  // newest events said. None of them decides anything: they only describe what NEO reported.
  private plan: PlanTracker;
  private action = new ActionTracker();
  private notice: HeldNotice | null = null;
  private stopRequestedAt = 0;

  // The last file editor the user was in. Focusing this sidebar does not change it.
  private lastEditor: vscode.TextEditor | undefined;
  private editorTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];
  // What NEO produced (src/changes.ts): the changed files and their diffs.
  private changes = new ChangesController((m) => this.post(m));
  // What NEO designed and plans to build (src/plan.ts): the documents before Execute.
  private artifacts = new PlanArtifacts();
  // NEO's sessions, "since you were away", and the read-only session snapshots (src/sessions.ts).
  private sessions: SessionsController;
  // The context keys last set, so each is only sent to VS Code when it changes.
  private contextKeys: Partial<NeoContextKeys> = {};

  constructor(private readonly extensionUri: vscode.Uri, store?: vscode.Memento) {
    this.client = new NeoClient(serverUrl());
    // A plan read from disk arrives after the state that needed it; repaint when it does.
    this.plan = new PlanTracker(store, () => this.postState());
    this.state = this.blankState("connecting");
    this.sessions = new SessionsController({
      client: () => this.client,
      store,
      changed: () => this.postState(),
      // "Seen" means on screen: the sidebar is visible and the window has focus.
      viewed: () => Boolean(this.view?.visible) && (vscode.window.state?.focused ?? true),
      projectName: () => this.state.project?.name,
      status: () => ({ phase: this.state.phase, busy: this.state.busy, waiting: this.state.awaiting || this.state.atGate }),
      startSession: async () => void (await this.startSession()),
    });
    this.trackEditor(vscode.window.activeTextEditor);
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => this.trackEditor(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.trackEditor(e.textEditor)),
    );
  }

  // --- VS Code plumbing -------------------------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: Inbound) => void this.onMessage(m));
    view.onDidDispose(() => {
      this.view = undefined;
    });
    // Showing the sidebar is when unseen activity becomes seen (src/sessions.ts).
    view.onDidChangeVisibility?.(() => this.postState());
  }

  dispose(): void {
    this.stopOfflinePoll();
    this.stopProject();
    if (this.editorTimer) clearTimeout(this.editorTimer);
    this.disposables.forEach((d) => d.dispose());
    this.changes.dispose();
    this.sessions.dispose();
  }

  // --- workspace context ------------------------------------------------------------------

  /** Follow the user's file editor; the suggested chip changes with it, debounced. */
  private trackEditor(editor: vscode.TextEditor | undefined): void {
    if (!editor || editor.document.uri.scheme !== "file") return;
    this.lastEditor = editor;
    if (this.editorTimer) clearTimeout(this.editorTimer);
    this.editorTimer = setTimeout(() => {
      this.editorTimer = undefined;
      this.postState();
    }, 200);
  }

  private editor(): vscode.TextEditor | undefined {
    const e = this.lastEditor;
    return e && !e.document.isClosed ? e : undefined;
  }

  /** What one click on the suggested chip would attach: the selection if there is one. */
  private suggestion(): ViewState["suggestion"] {
    const e = this.editor();
    if (!e) return null;
    const rel = vscode.workspace.asRelativePath(e.document.uri, false);
    const lines = e.selection.isEmpty ? undefined : selectedLines(e.selection);
    if (this.attachments.some((a) => sameTarget(a, { uri: e.document.uri, lines }))) return null;
    return { kind: lines ? "selection" : "file", label: labelOf({ path: rel, lines }) };
  }

  /**
   * Attach context. Every path here starts with an explicit act of the user's, and the chip it
   * makes stays visible and removable until the message is sent.
   */
  async addContext(source: ContextSource): Promise<void> {
    if (this.state.mode !== "project") {
      void vscode.window.showInformationMessage("NEO: open or create a NEO project first, then attach context to a message.");
      return;
    }
    let kind: "file" | "selection" | "choose" | undefined;
    const editor = this.editor();
    if (source === "file" || source === "selection") kind = source;
    else if (source === "at") kind = "choose";
    else if (source === "suggested") kind = editor && !editor.selection.isEmpty ? "selection" : "file";
    else {
      type Item = vscode.QuickPickItem & { action: "file" | "selection" | "choose" };
      const items: Item[] = [];
      if (editor) {
        const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
        items.push({ action: "file", label: "$(file) Current file", description: rel });
        if (!editor.selection.isEmpty) {
          const lines = selectedLines(editor.selection);
          items.push({ action: "selection", label: "$(selection) Current selection", description: labelOf({ path: rel, lines }) });
        }
      }
      items.push({ action: "choose", label: "$(search) Choose file…", description: "from this workspace" });
      kind = (await vscode.window.showQuickPick(items, { title: "Add context to your NEO message" }))?.action;
    }
    if (!kind) return;

    if (this.attachments.length >= MAX_ITEMS) {
      this.post({ type: "toast", level: "error", text: `At most ${MAX_ITEMS} attachments per message. Remove one first.` });
      return;
    }
    let attachment: Attachment;
    try {
      if (kind === "choose") {
        const uri = await pickWorkspaceFile();
        if (!uri) return;
        attachment = await fileAttachment(uri);
      } else if (!editor) {
        throw new ContextError("Open a file in the editor first.");
      } else if (kind === "selection") {
        attachment = selectionAttachment(editor);
      } else {
        attachment = await fileAttachment(editor.document.uri);
      }
    } catch (err) {
      this.post({ type: "toast", level: "error", text: errorText(err) });
      return;
    }
    if (this.attachments.some((a) => sameTarget(a, attachment))) {
      this.post({ type: "toast", level: "info", text: `${labelOf(attachment)} is already attached.` });
      return;
    }
    this.attachments.push(attachment);
    if (source === "at") this.post({ type: "atResolved" });
    this.postState();
  }

  private removeContext(id: string): void {
    this.attachments = this.attachments.filter((a) => a.id !== id);
    this.postState();
  }

  private clearContext(): void {
    this.attachments = [];
  }

  /**
   * Start over: a changed setting or workspace leads here, and so does Retry when no project is
   * open. Everything is read again from NEO; attached context was gathered for the old state.
   */
  async connect(): Promise<void> {
    this.client = new NeoClient(serverUrl());
    this.stopOfflinePoll();
    this.stopProject();
    this.clearContext();
    this.failures = 0;
    const gen = ++this.generation;
    const folder = currentFolder();
    this.state = {
      ...this.blankState("connecting"),
      folder,
      folderName: folder ? path.basename(folder) : undefined,
    };
    this.postState();

    let runtimeReachable: boolean;
    try {
      runtimeReachable = Boolean((await this.client.status()).opencode_reachable);
    } catch (err) {
      if (gen !== this.generation) return;
      this.state.mode = folder ? "noProject" : "noFolder";
      this.fail(err, "connect");
      return;
    }
    if (gen !== this.generation) return;
    this.state.connection = "connected";
    this.state.runtimeReachable = runtimeReachable;

    if (!folder) {
      this.state.mode = "noFolder";
      this.postState();
      return;
    }
    try {
      const match = projectForFolder(await this.client.listProjects(), folder);
      if (gen !== this.generation) return;
      if (match) {
        await this.loadProject(match.id, gen);
      } else {
        this.state.mode = "noProject";
        this.postState();
      }
    } catch (err) {
      if (gen !== this.generation) return;
      this.state.mode = "noProject";
      this.fail(err, "listProjects");
    }
  }

  /**
   * NEO: Connect, and every Retry button. With a project on screen it stays there: the same project
   * is read again and its stream reopened, and the draft, the attached context and the header are
   * kept. Without one, this is `connect()`. Only reads are repeated; nothing is sent to NEO.
   */
  async retry(): Promise<void> {
    const project = this.state.project;
    if (!project || this.state.mode !== "project") return this.connect();
    if (this.state.retrying) return;
    this.state.retrying = true;
    this.postState();
    try {
      // NEO first: a down server leaves the stream and the resync running as they are.
      this.state.runtimeReachable = Boolean((await this.client.status()).opencode_reachable);
    } catch (err) {
      this.state.retrying = false;
      this.noteDown(err, true);
      return;
    }
    this.state.retrying = false;
    if (project !== this.state.project) return;           // switched away meanwhile
    this.noteUp();
    const gen = ++this.generation;
    this.stopProject();
    await this.loadProject(project.id, gen);
  }

  /** NEO: Refresh — re-read everything for the current project, or reconnect if there is none. */
  async refresh(): Promise<void> {
    if (this.state.project && this.state.mode === "project") {
      if (this.state.connection !== "connected") return this.retry();
      const gen = ++this.generation;
      this.stopProject();
      await this.loadProject(this.state.project.id, gen);
    } else {
      await this.connect();
    }
  }

  /**
   * An action that needs NEO, asked for while it is not reachable (the title bar and the Command
   * Palette stay enabled): say why it cannot run, and offer what can fix it.
   */
  private async explainOffline(what: string): Promise<void> {
    const text = this.state.connection === "unreachable"
      ? `NEO is offline. ${what} needs the NEO server at ${this.client.baseUrl}. Start NEO, then Retry.`
      : `NEO is reconnecting. ${what} needs a confirmed connection to ${this.client.baseUrl}; try again once the sidebar says Connected.`;
    const picked = await vscode.window.showWarningMessage(
      text,
      "Retry",
      OPEN_SETTINGS,
    );
    if (picked === "Retry") await this.retry();
    else if (picked === OPEN_SETTINGS) await openSettings();
  }

  /** See ViewState.ready. */
  private isReady(): boolean {
    const s = this.state;
    // The header's own rule for "Connected" (media/chat.js): a dropped stream reads "Reconnecting…".
    return s.connection === "connected" && s.stream !== "reconnecting";
  }

  /**
   * A change to NEO's state asked for while the connection is not confirmed (the webview disables
   * these, so this is the backstop): nothing is sent. Returns true when the action may go ahead.
   */
  private confirmReady(): boolean {
    if (this.isReady()) return true;
    void this.explainOffline("This action");
    return false;
  }

  /** NEO has stopped answering (not merely still being connected to). */
  private offlineNow(): boolean {
    return this.state.connection === "unreachable" || this.state.connection === "reconnecting";
  }

  /** NEO: New Project — show the form. */
  showNewProject(): void {
    if (this.offlineNow()) {
      void this.explainOffline("Creating a project");
      return;
    }
    const folder = this.state.folder;
    this.post({
      type: "showNewProject",
      name: folder ? path.basename(folder) : "",
      hasProject: this.folderIsSelectedProject(),
    });
  }

  /**
   * NEO: Projects — pick another registered project and show it here.
   *
   * Only what opening a project in the web UI does: read its state and history and follow its
   * stream. Nothing is sent to it, so switching never starts work or a session.
   */
  async switchProject(): Promise<void> {
    if (this.offlineNow()) {
      void this.explainOffline("The project list");
      return;
    }
    let projects;
    try {
      projects = await this.client.listProjects();
    } catch (err) {
      const shown = describeError(err, "listProjects");
      if (shown.offline) this.wentOffline(err, shown);
      // Listing is a read: retrying it is safe.
      void notifyError(shown, () => this.switchProject());
      return;
    }
    if (!projects.length) {
      void vscode.window.showInformationMessage("NEO has no projects yet.");
      return;
    }
    const current = this.state.project?.id;
    const folder = this.state.folder;
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = projects.map((p) => {
      const tags = [p.phase === "setup" ? "not started" : p.phase];
      if (p.id === current) tags.unshift("current");
      if (folder && samePath(p.path, folder)) tags.push("this workspace");
      if (p.path_missing) tags.push("folder missing");
      return {
        id: p.id,
        label: `${p.id === current ? "$(check)" : "$(blank)"} ${p.name}`,
        description: tags.join(" · "),
        detail: p.path,
      };
    });
    // The current project first, so Enter on an unchanged list is a no-op.
    items.sort((a, b) => Number(b.id === current) - Number(a.id === current));
    const picked = await vscode.window.showQuickPick(items, {
      title: "NEO projects",
      placeHolder: "Switch the sidebar to a NEO project",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked || picked.id === current) return;

    const gen = ++this.generation;
    this.stopProject();                              // closes the old stream and resync timer
    // Clear the old transcript at once. This also resets the webview's seq high-water mark, which
    // matters: the new project's events have their own, possibly lower, sequence numbers.
    this.post({ type: "history", events: [] });
    this.post({ type: "gateDone" });                 // no comment or refusal carries across
    this.clearContext();                             // context was gathered for the other project
    this.state.project = undefined;
    await this.loadProject(picked.id, gen);
  }

  /** NEO: Sessions — the project's sessions; one picked opens as a read-only snapshot. */
  showSessions(): Promise<void> {
    return this.sessions.pick();
  }

  /** Whether the selected project is the one living in the open folder. */
  private folderIsSelectedProject(): boolean {
    const { project, folder } = this.state;
    return Boolean(project && folder && samePath(project.path, folder));
  }

  openInBrowser(): void {
    // The Web UI is served by the NEO server itself: offline, the browser would open on nothing.
    if (this.offlineNow()) {
      void this.explainOffline("The NEO Web UI");
      return;
    }
    const id = this.state.project?.id;
    const url = this.client.baseUrl + (id ? `/?project=${encodeURIComponent(id)}` : "/");
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }

  // --- commands: reaching what the sidebar already shows ----------------------------------
  //
  // Each one only opens or ends what the sidebar itself offers (the Stop button, a chip's Preview,
  // the Changes strip, NEO: Sessions), through the same code. None of them loads, switches or
  // starts a session, so looking at anything never changes the current one.

  /** The project the commands act on, or undefined after saying there is none. */
  private commandProject(): { id: string; name: string; path: string } | undefined {
    if (this.state.mode === "project" && this.state.project) return this.state.project;
    void vscode.window.showInformationMessage("NEO: open a NEO project first (NEO: Projects, or NEO: New Project).");
    return undefined;
  }

  /** NEO: Stop Current Work - the sidebar's own Stop. Nothing to stop is said, not ignored. */
  async stopCurrentWork(): Promise<void> {
    const project = this.commandProject();
    if (!project) return;
    if (this.state.stopping) {
      void vscode.window.showInformationMessage(`NEO: already stopping the current work on ${project.name}.`);
      return;
    }
    if (!this.state.busy) {
      void vscode.window.showInformationMessage(`NEO: nothing is running on ${project.name} right now.`);
      return;
    }
    // The chat is where "stopping…" and then "stopped" are reported.
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    await this.abort();
  }

  /** NEO: Open Design / NEO: Open Plan - the current session's document, as the chip's Preview opens it. */
  async openDocument(kind: "design" | "plan"): Promise<void> {
    const project = this.commandProject();
    if (!project) return;
    const outcome = await this.artifacts.openKind(
      kind === "plan" ? "plan" : "document",
      this.state.stages as StageLike[],
      async (items) =>
        (await vscode.window.showQuickPick(
          items.map((i) => ({ item: i, label: i.label, description: `${i.path} · ${i.status}` })),
          { title: "NEO: Open Design", placeHolder: "Which document of the current session?" },
        ))?.item,
    );
    if (outcome === "none") {
      const sessionKind = this.state.sessions?.active?.kind;
      const what = sessionKind ? `it is a ${kindLabel(sessionKind)} session, which` : "this session";
      void vscode.window.showInformationMessage(
        `NEO: the current session of ${project.name} has no ${kind}: ${what} does not go through a ${kind} step.`,
      );
    } else if (outcome === "pending") {
      void vscode.window.showInformationMessage(
        `NEO: no ${kind} yet in the current session of ${project.name}. It can be opened once NEO has written it.`,
      );
    }
  }

  /** NEO: Open Current Changes - the Changes strip's files; one picked opens its native diff. */
  async openChanges(): Promise<void> {
    const project = this.commandProject();
    if (!project) return;
    const info = (m: string) => void vscode.window.showInformationMessage(`NEO: ${m}`);
    if (!changesPhase(this.state.phase)) {
      info(`no changes yet on ${project.name}. NEO's changes are listed from Execute on.`);
      return;
    }
    const snap = this.changes.current(project.path);
    if (!snap) {
      info("still reading the changes. Try again in a moment.");
      return;
    }
    if (snap.error) {
      void vscode.window.showWarningMessage(`NEO: could not read the changes: ${snap.error}`);
      return;
    }
    if (!snap.files.length) {
      info(`no files changed${snap.label ? ` (${snap.label})` : ""}.`);
      return;
    }
    const count = (n: number | null, sign: string) => (n === null ? "binary" : `${sign}${n}`);
    const picked = await vscode.window.showQuickPick(
      snap.files.map((f) => ({
        path: f.path,
        label: path.posix.basename(f.path),
        description: `${f.untracked ? "U" : f.status} · ${count(f.additions, "+")} ${count(f.deletions, "−")}`,
        detail: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
      })),
      {
        title: `NEO: Changes${snap.label ? ` · ${snap.label}` : ""}`,
        placeHolder:
          `${snap.files.length} changed file${snap.files.length === 1 ? "" : "s"}${snap.truncated ? " (list truncated)" : ""}` +
          " - pick one to open its read-only diff",
        matchOnDetail: true,
      },
    );
    if (picked) await this.changes.openDiff(picked.path);
  }

  /** NEO: Go to… - the places the current project has right now, with where each stands. */
  async goTo(): Promise<void> {
    const project = this.commandProject();
    if (!project) return;
    type Item = vscode.QuickPickItem & { go: () => Thenable<unknown> };
    const items: Item[] = [];
    const active = this.state.sessions?.active;
    items.push({
      label: "$(comment-discussion) Current session",
      description: active ? `${active.title} · ${kindLabel(active.kind)} · ${sessionStateLabel(active.state, true)}` : project.name,
      detail: "Show the NEO chat",
      go: () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`),
    });
    const describe = (i: ArtifactView) =>
      i.kind === "plan" && i.current
        ? `task ${i.current.index} of ${i.current.total}`
        : i.atGate ? "awaiting your approval" : i.status === "changes" ? "changes requested" : i.status;
    const seen = new Set<string>();
    for (const doc of this.artifacts.current()) {
      const kind = doc.kind === "plan" ? "plan" : "design";
      if (seen.has(kind)) continue;               // Open Design asks which, if there are several
      seen.add(kind);
      items.push({
        label: `${kind === "plan" ? "$(checklist)" : "$(book)"} ${doc.label}`,
        description: describe(doc),
        detail: `${doc.path} - read-only preview`,
        go: () => this.openDocument(kind),
      });
    }
    if (changesPhase(this.state.phase)) {
      const snap = this.changes.current(project.path);
      const n = snap ? snap.files.length : 0;
      items.push({
        label: "$(diff) Changes",
        description: snap ? `${n} file${n === 1 ? "" : "s"}` : "reading…",
        detail: "Open a changed file's diff",
        go: () => this.openChanges(),
      });
    }
    const count = this.state.sessions?.list.length;
    items.push({
      label: "$(history) Sessions",
      description: count ? `${count} session${count === 1 ? "" : "s"}` : undefined,
      detail: "Open a session as a read-only snapshot",
      go: () => this.showSessions(),
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: `NEO: Go to · ${project.name}`,
      placeHolder: "Where to?",
      matchOnDescription: true,
    });
    if (picked) await picked.go();
  }

  // --- project lifecycle ------------------------------------------------------------------

  private async loadProject(id: string, gen: number): Promise<void> {
    // Reloading the project on screen (Refresh, Retry, a new session) keeps it on screen meanwhile.
    const reload = this.state.mode === "project" && this.state.project?.id === id;
    this.orphaned = false;
    if (!reload) {
      this.state.mode = "loading";
      this.postState();
    }
    let detail: ProjectDetail;
    try {
      detail = await this.client.project(id, HISTORY);
    } catch (err) {
      if (gen !== this.generation) return;
      if (this.state.project?.id === id) {
        // It stays on screen, and the 10-second read keeps trying: when NEO answers again the
        // project is reloaded from there (see resync), with no Retry needed.
        this.state.mode = "project";
        this.orphaned = true;
        this.resyncTimer ??= setInterval(() => void this.resync(), RESYNC_MS);
      }
      this.fail(err, reload ? "refresh" : "loadProject");
      return;
    }
    if (gen !== this.generation) return;

    const p = detail.project;
    this.state.mode = "project";
    this.state.project = { id: p.id, name: p.name, path: p.path, idea: p.idea ?? undefined };
    this.plan.start(p.id, p.path);
    // Reads the last-seen anchor before anything below can mark this history as seen.
    this.sessions.open(p.id, detail);
    // The plan gate may be far behind in the history (or gone from the window entirely). Every
    // gate in what was read is offered; only the plan's own document is kept.
    for (const ev of detail.history) {
      if (ev.kind === "gate") {
        this.plan.noteGate(ev.phase as string | undefined, ev.artifact_path as string | undefined, ev.artifact, detail.plan_progress?.total);
      }
      // A re-plan while this window was closed makes the remembered progress stale.
      if (ev.kind === "gate" || ev.kind === "phase") this.plan.notePhase(ev.phase as string | undefined, ev.seq);
    }
    this.applyDetail(detail);

    const events = detail.history.filter((e) => !IGNORED_KINDS.has(e.kind));
    this.transcript = events.slice(-TRANSCRIPT_CAP);
    this.lastSeq = maxSeq(detail.history, 0);
    // State first: the history is drawn against it (the kickoff needs this project's idea).
    this.postState();
    this.post({ type: "history", events: this.transcript, total: detail.history_total });

    this.stream = new SseStream(this.client.streamUrl(id), {
      onOpen: (reconnect) => {
        if (gen !== this.generation) return;
        this.state.stream = "up";
        this.state.streamRetryAt = undefined;
        this.noteUp();
        // Say so while the gap is being filled, so a reconnect is visibly finished rather than
        // just silently no longer broken.
        if (reconnect) this.state.catchingUp = true;
        this.postState();
        // Always, not only on a reconnect: the first open also leaves a gap — whatever NEO
        // emitted between the history read above and the subscription.
        void this.catchUp(id, gen);
      },
      onEvent: (data) => {
        if (gen !== this.generation) return;
        const ev = data as NeoEvent;
        if (!ev || typeof ev.kind !== "string") return;
        if (this.filling) this.held.push(ev);
        else this.deliver(ev);
      },
      onDown: (_err, retryInMs) => {
        if (gen !== this.generation) return;
        this.state.stream = "reconnecting";
        this.state.streamRetryAt = Date.now() + retryInMs;
        // The 10-second project read is the fallback while the stream is down; it keeps the
        // phase, the gate and the plan progress moving. It is left running on purpose.
        this.postState();
      },
    });
    this.stream.start();
    this.resyncTimer = setInterval(() => void this.resync(), RESYNC_MS);
  }

  private stopProject(): void {
    this.stream?.stop();
    this.stream = undefined;
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.resyncTimer = undefined;
    this.filling = false;
    this.held = [];
    this.outbox = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.lastSeq = 0;
    this.transcript = [];
    this.plan.stop();
    this.sessions.close();
    this.action.reset();
    this.notice = null;
    this.stopRequestedAt = 0;
    this.state.stopping = false;
    this.state.stoppedAt = undefined;
    this.state.userStopped = false;
    this.state.catchingUp = false;
    // This stream is closed: "up" belongs to the project just left, not to the next one.
    this.state.stream = "off";
    this.state.streamRetryAt = undefined;
  }

  /**
   * Deliver what the stream missed. SSE does not replay, so after any (re)open the history is read
   * again and the events newer than the last one delivered are passed on — in order, before
   * anything the live stream produced meanwhile, which is held until this finishes.
   */
  private async catchUp(id: string, gen: number): Promise<void> {
    this.filling = true;
    try {
      const detail = await this.client.project(id, HISTORY);
      if (gen !== this.generation) return;
      for (const ev of detail.history) {
        if (typeof ev.seq === "number" && ev.seq > this.lastSeq) this.deliver(ev);
      }
      this.applyDetail(detail);
    } catch {
      // The next resync tick or reconnect tries again; the live stream is still flowing.
    } finally {
      if (gen === this.generation) {
        this.filling = false;
        this.state.catchingUp = false;
        const held = this.held;
        this.held = [];
        held.forEach((ev) => this.deliver(ev));
        this.postState();
      }
    }
  }

  /** One live event: dedupe, update the state copy, forward to the webview. */
  private deliver(ev: NeoEvent): void {
    if (typeof ev.seq === "number") {
      if (ev.seq <= this.lastSeq) return;
      this.lastSeq = ev.seq;
      this.sessions.noteEvent(ev);
    }
    this.applyEvent(ev);
    if (IGNORED_KINDS.has(ev.kind)) return;
    this.transcript.push(ev);
    if (this.transcript.length > TRANSCRIPT_CAP) this.transcript.splice(0, this.transcript.length - TRANSCRIPT_CAP);
    this.outbox.push(ev);
    // Text arrives as many small deltas; batching them keeps the message channel quiet.
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        const events = this.outbox;
        this.outbox = [];
        if (events.length) this.post({ type: "events", events });
        this.postState();
      }, 40);
    }
  }

  /**
   * What a live event says about state. Only mirrors what NEO announced — it never infers a phase
   * the server did not name.
   */
  private applyEvent(ev: NeoEvent): void {
    const s = this.state;
    // What NEO is doing right now, from the events it already sends. Reading only: this never
    // writes a phase, a gate or a count.
    this.action.note(ev, s.phase);
    // A step was probably just ticked: re-read now rather than at the next 10-second tick.
    if (touchesPlan(ev)) setTimeout(() => void this.resync(), 300);
    switch (ev.kind) {
      case "phase": {
        const phase = String(ev.phase ?? "");
        if (!phase) break;
        s.phase = phase;
        s.userStopped = false;
        this.plan.notePhase(phase, ev.seq);
        this.notice = null;                          // a new phase answers whatever the last one said
        if (!phase.endsWith("-gate")) {
          s.atGate = false;
          s.gate = null;
        }
        // The rail (stages) is computed by NEO; fetch it rather than recompute it here.
        setTimeout(() => void this.resync(), 300);
        break;
      }
      case "gate": {
        s.atGate = true;
        this.notice = null;                          // a gate is the new state; the old one is history
        if (typeof ev.phase === "string") s.phase = ev.phase;
        this.plan.notePhase(ev.phase as string | undefined, ev.seq);
        this.plan.noteGate(ev.phase as string | undefined, ev.artifact_path as string | undefined, ev.artifact, s.planProgress?.total);
        s.gate = {
          phase: typeof ev.phase === "string" ? ev.phase : s.phase,
          title: ev.title as string | undefined,
          artifact_path: ev.artifact_path as string | undefined,
          artifact: ev.artifact as string | undefined,
          artifact_missing: ev.artifact_missing as boolean | undefined,
          checks: Array.isArray(ev.checks) ? (ev.checks as Gate["checks"]) : [],
          checks_pending: false,
        };
        s.busy = false;
        setTimeout(() => void this.resync(), 300);
        break;
      }
      case "status":
        if (typeof ev.busy === "boolean") s.busy = ev.busy;
        if (ev.busy === true) s.userStopped = false;   // a new turn: whatever ends it is not the Stop
        break;
      case "idle":
        s.busy = false;
        break;
      case "user":
        s.awaiting = false;
        s.pendingRequest = null;
        this.notice = null;                          // the user answered: a stall notice is over
        s.stoppedAt = undefined;
        s.userStopped = false;
        // NEO clears its stall when the user writes; this copy follows at the next re-read.
        s.needsAttention = false;
        s.attentionReason = null;
        break;
      case "question":
        s.awaiting = true;
        s.pendingRequest = typeof ev.request === "string" ? ev.request : null;
        break;
      case "notice": {
        // Only the notices that describe a state the user is still in reach the live line; every
        // notice is drawn in the transcript either way, so nothing is said twice.
        const held = noticeOf(ev);
        // The stall NEO reports for the turn the user stopped is the Stop, said as such by buildLive.
        if (held && !(s.userStopped && stopExplains(ev.stalled))) this.notice = held;
        break;
      }
    }
  }

  /**
   * Re-read the authoritative state. Never the transcript: messages come only from the stream and
   * the catch-up, so nothing here can draw one twice.
   */
  private async resync(): Promise<void> {
    const project = this.state.project;
    if (!project || this.resyncing) return;
    const gen = this.generation;
    const seq = ++this.resyncSeq;
    this.resyncing = true;
    try {
      const detail = await this.client.project(project.id, 1);
      if (gen !== this.generation || seq < this.resyncApplied) return;
      this.resyncApplied = seq;
      this.noteUp();
      if (this.orphaned) {
        // A reload failed while NEO was down, so this project has no stream: reload it now.
        this.resyncing = false;
        const next = ++this.generation;
        this.stopProject();
        await this.loadProject(project.id, next);
        return;
      }
      this.applyDetail(detail);
      this.postState();
    } catch (err) {
      if (gen !== this.generation) return;
      if (err instanceof NeoUnreachable) this.noteDown(err);
    } finally {
      this.resyncing = false;
    }
  }

  /**
   * A read of the open project failed to reach NEO. The project, transcript, draft and attached
   * context all stay; the first failures say "Reconnecting…", and after OFFLINE_AFTER in a row (or
   * an explicit Retry that failed) the sidebar says NEO is offline. The reads go on regardless.
   */
  private noteDown(err: unknown, hard = false): void {
    this.failures += 1;
    const shown = describeError(err, "connect");
    if (this.state.connection === "connected" || hard) logError(shown);
    this.state.offline = problemOf(shown);
    this.state.connection = hard || this.failures >= OFFLINE_AFTER ? "unreachable" : "reconnecting";
    this.postState();
  }

  /** NEO answered. After a loss of connection, say it is back. */
  private noteUp(): void {
    const was = this.state.connection;
    this.failures = 0;
    this.state.offline = undefined;
    this.state.connection = "connected";
    if (was === "reconnecting" || was === "unreachable") {
      this.post({ type: "toast", level: "ok", text: "Reconnected to NEO" });
    }
  }

  /** NEO could not be reached with no project open: the offline empty state, and a slow check. */
  private wentOffline(err: unknown, shown = describeError(err, "connect")): void {
    if (this.state.project && this.state.mode === "project") {
      this.noteDown(err);
      return;
    }
    logError(shown);
    this.state.connection = "unreachable";
    this.state.offline = problemOf(shown);
    this.state.problem = undefined;
    this.postState();
    this.pollOffline();
  }

  /** Checks for NEO every 10 seconds while it is offline and no project is open; connects once it answers. */
  private pollOffline(): void {
    if (this.offlineTimer) return;
    const gen = this.generation;
    this.offlineTimer = setInterval(async () => {
      if (gen !== this.generation || this.state.connection !== "unreachable") return this.stopOfflinePoll();
      try {
        await this.client.status();
      } catch {
        return;
      }
      if (gen !== this.generation) return;
      this.stopOfflinePoll();
      void this.connect();
    }, RESYNC_MS);
    this.offlineTimer.unref?.();
  }

  private stopOfflinePoll(): void {
    if (this.offlineTimer) clearInterval(this.offlineTimer);
    this.offlineTimer = undefined;
  }

  private applyDetail(d: ProjectDetail): void {
    const s = this.state;
    s.phase = d.phase;
    s.stages = d.stages ?? [];
    s.busy = Boolean(d.busy);
    s.atGate = Boolean(d.at_gate && d.gate);
    s.gate = d.at_gate && d.gate ? { ...d.gate, phase: d.phase } : null;
    s.awaiting = Boolean(d.awaiting_answer);
    s.pendingRequest = d.pending_request ?? null;
    s.needsAttention = Boolean(d.needs_attention);
    s.attentionReason = d.attention_reason ?? null;
    s.planProgress = d.plan_progress ?? null;
    this.artifacts.noteDetail(d);
    this.sessions.noteDetail(d);
    // An open gate carries its document: the plan gate is where the task titles come from.
    if (s.gate) this.plan.noteGate(s.gate.phase, s.gate.artifact_path, s.gate.artifact, s.planProgress?.total);
    if (!s.busy) this.action.reset();
    else s.userStopped = false;                      // NEO is running a turn the user did not stop
    if (s.project) {
      s.project.name = d.project.name;
      if (d.project.idea) s.project.idea = d.project.idea;
    }
  }

  // --- webview actions --------------------------------------------------------------------

  private async onMessage(m: Inbound): Promise<void> {
    if (m.type.startsWith("plan.")) {
      await this.artifacts.onMessage(m as unknown as PlanMessage);
      return;
    }
    if (m.type.startsWith("sessions.")) {
      await this.sessions.onMessage(m as unknown as SessionsMessage);
      return;
    }
    if (m.type.startsWith("changes.")) {
      await this.changes.onMessage(m as unknown as ChangesMessage);
      return;
    }
    switch (m.type) {
      case "ready":
        this.postState();
        if (this.state.project) this.post({ type: "history", events: this.transcript });
        return;
      case "connect":
      case "retry":
        return this.retry();
      case "openSettings":
        await openSettings();
        return;
      case "pickFolder":
        // VS Code's own folder dialog, the same on every platform; the window reopens on the folder.
        await vscode.commands.executeCommand("vscode.openFolder");
        return;
      case "refresh":
        return this.refresh();
      case "createProject":
        return this.createProject(m.name, m.idea, m.interaction);
      case "send":
        return this.send(m.text);
      case "answer":
        return this.answer(m);
      case "approve":
        return this.approve(m.reason);
      case "reject":
        return this.reject(m.feedback);
      case "abort":
        return this.abort();
      case "openBrowser":
        return this.openInBrowser();
      case "newProject":
        return this.showNewProject();
      case "switchProject":
        return this.switchProject();
      case "openFolder":
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(m.path));
        return;
      case "addContext":
        return this.addContext(m.source);
      case "removeContext":
        return this.removeContext(m.id);
      case "startSession":
        await this.startSession(m.text);
        return;
    }
  }

  private async send(typed: string): Promise<void> {
    const project = this.state.project;
    typed = (typed ?? "").trim();
    if (!project || !typed) return;
    if (!this.isReady()) {
      // Not sent, so nothing can arrive twice: the text goes back in the box, the chips stay.
      this.post({
        type: "sendFailed",
        text: typed,
        message: "Not sent: the connection to NEO is not confirmed.",
        hint: "Your text and attached files are kept. Send again once the sidebar says Connected.",
      });
      return;
    }
    const sending = [...this.attachments];
    try {
      // Read now, so NEO gets the files as they are at the moment of sending. A failure here
      // (too large, deleted, binary) keeps both the typed text and the chips.
      const text = await composeMessage(typed, sending);
      // The phase is read fresh, as the web UI does: a setup project is started, anything else
      // gets an ordinary message. Which phase follows is NEO's answer, not ours.
      const fresh = await this.client.project(project.id, 1);
      // A completed session takes no more work: what is sent next must start a new session, never
      // run inside the finished one. Refused here, text kept, whatever the webview thought.
      if (fresh.phase === "done") {
        this.state.phase = fresh.phase;
        this.postState();
        this.post({ type: "sendFailed", text: typed, message: DONE_REFUSAL });
        return;
      }
      if (fresh.phase === "setup") {
        // This text becomes the project's idea; say so before the kickoff it is wrapped in arrives.
        project.idea = text;
        this.postState();
        const started = await this.client.start(project.id, text);
        if (started?.phase) this.state.phase = started.phase;
      } else {
        await this.client.message(project.id, text);
      }
      this.state.busy = true;
      // A new message answers whatever the last stall or stop said.
      this.notice = null;
      this.state.stoppedAt = undefined;
      this.clearAttention();
      // Sent: these chips are now part of the message. Anything attached meanwhile stays.
      this.attachments = this.attachments.filter((a) => !sending.includes(a));
      this.postState();
    } catch (err) {
      // Never resent from here: the text goes back in the box and the user decides.
      const shown = this.actionFailed(err, "send");
      this.post({ type: "sendFailed", text: typed, ...shown });
    }
  }

  /**
   * New work on this project once its current session is complete: NEO's own POST /sessions. The
   * finished session ends and keeps its history; a new one starts at its kind's first phase; the
   * sidebar then reloads onto it, exactly as opening the project would.
   *
   * `typed` is the message box's text; without it (the command, the Sessions picker) the request is
   * asked for. Resolves true only once NEO has started the session.
   */
  async startSession(typed?: string): Promise<boolean> {
    const project = this.state.project;
    const done = (outcome: "started" | "cancelled" | "failed", problem?: Problem) => {
      this.post({ type: "sessionStart", outcome, ...(problem ? { message: problem.summary, hint: problem.hint, detail: problem.detail } : {}) });
      return outcome === "started";
    };
    if (!project) {
      void vscode.window.showInformationMessage("NEO: open a NEO project first.");
      return done("cancelled");
    }
    if (!this.isReady()) {
      void this.explainOffline("Starting a new session");
      return done("cancelled");
    }
    let kinds: Record<string, SessionKind>;
    try {
      const fresh = await this.client.project(project.id, 1);
      if (fresh.phase !== "done") {
        void vscode.window.showInformationMessage(
          `NEO: the current session of ${project.name} is still in progress (${fresh.phase}). ` +
            "A new session can start once it is complete.",
        );
        return done("cancelled");
      }
      kinds = (await this.client.sessions(project.id)).kinds;
    } catch (err) {
      return done("failed", this.actionFailed(err, "startSession", false));
    }

    let request = (typed ?? "").trim();
    if (!request) {
      request = (await vscode.window.showInputBox({
        title: `New session on ${project.name}`,
        prompt: "What should NEO work on next? The completed session stays as read-only history.",
        placeHolder: 'e.g. Add a GET /health endpoint that returns {"status":"ok"}.',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : "Describe the work."),
      }))?.trim() ?? "";
      if (!request) return done("cancelled");
    }

    // How much of the pipeline: NEO's own kinds, labels and descriptions, in NEO's order.
    // (`sessionKind`, not `kind`: QuickPickItem has a `kind` of its own.)
    type Item = vscode.QuickPickItem & { sessionKind: string };
    const items: Item[] = Object.entries(kinds).map(([key, k]) => ({
      sessionKind: key,
      label: k.label || key,
      description: k.phase ? `starts at ${k.phase}` : undefined,
      detail: k.description,
    }));
    let kind = "full";
    if (items.length > 1) {
      const picked = await vscode.window.showQuickPick(items, {
        title: `New session on ${project.name}`,
        placeHolder: "How much of NEO's pipeline should this work go through?",
        ignoreFocusOut: true,
      });
      if (!picked) return done("cancelled");
      kind = picked.sessionKind;
    } else if (items.length === 1) {
      kind = items[0].sessionKind;
    }

    const sending = typed !== undefined ? [...this.attachments] : [];
    let text: string;
    try {
      text = await composeMessage(request, sending);
    } catch (err) {
      return done("failed", { summary: "Could not start a new session.", hint: errorText(err) });
    }
    if (text.length > SESSION_REQUEST_MAX) {
      return done("failed", {
        summary: "Could not start a new session.",
        hint:
          `A new session's request can be at most ${SESSION_REQUEST_MAX.toLocaleString()} characters ` +
          `(this one is ${text.length.toLocaleString()} with its attachments). Remove an attachment or shorten it.`,
      });
    }
    if (project !== this.state.project) return done("cancelled");      // switched away meanwhile
    try {
      await this.client.startSession(project.id, { kind, request: text });
    } catch (err) {
      // Not retried: a session that did start must not be started twice. The re-read shows which.
      return done("failed", this.actionFailed(err, "startSession"));
    }
    this.attachments = this.attachments.filter((a) => !sending.includes(a));
    done("started");
    this.post({ type: "toast", level: "ok", text: "New session started" });
    // Onto the new session: its own history, stream and state - as reopening the project shows it.
    const gen = ++this.generation;
    this.stopProject();
    await this.loadProject(project.id, gen);
    return true;
  }

  private async answer(m: { request?: string; text?: string; answers?: string[] }): Promise<void> {
    const project = this.state.project;
    if (!project) return;
    if (!this.isReady()) {
      this.post({ type: "answerFailed", message: "Not sent: the connection to NEO is not confirmed.", hint: "Answer again once the sidebar says Connected." });
      return;
    }
    this.notice = null;
    this.state.stoppedAt = undefined;
    this.clearAttention();
    try {
      if (m.answers && m.answers.length) {
        await this.client.answer(project.id, { answers: m.answers });
      } else if (m.request) {
        // A blocking question: answered on its own channel, which unblocks the waiting turn.
        await this.client.answer(project.id, { text: m.text ?? "" });
      } else {
        // A question asked in prose: the answer is simply the next message.
        await this.client.message(project.id, m.text ?? "");
      }
    } catch (err) {
      this.post({ type: "answerFailed", ...this.actionFailed(err, "answer") });
    }
  }

  private async approve(reason?: string): Promise<void> {
    const project = this.state.project;
    if (!project) return;
    if (!this.gateReady()) return;
    const overrule = reason && reason.trim() ? { reason: reason.trim() } : undefined;
    try {
      const r = await this.client.approve(project.id, overrule);
      this.gateClosed(r.phase);
    } catch (err) {
      this.gateRefused(err, "approve");
    }
  }

  private async reject(feedback: string): Promise<void> {
    const project = this.state.project;
    feedback = (feedback ?? "").trim();
    if (!project || !feedback) return;
    if (!this.gateReady()) return;
    try {
      const r = await this.client.reject(project.id, feedback);
      this.gateClosed(r.phase);
    } catch (err) {
      this.gateRefused(err, "reject");
    }
  }

  private gateReady(): boolean {
    if (this.isReady()) return true;
    this.post({ type: "gateFailed", message: "Not sent: the connection to NEO is not confirmed.", hint: "Decide the gate again once the sidebar says Connected." });
    return false;
  }

  /**
   * The user acted (wrote, answered, decided a gate): NEO clears its stall at once, and the copy here
   * would otherwise say "Waiting on you" until the next re-read. A new stall arrives as a new notice.
   */
  private clearAttention(): void {
    this.state.needsAttention = false;
    this.state.attentionReason = null;
    this.state.userStopped = false;
  }

  private gateClosed(phase: string): void {
    // The phase NEO just reported, not one worked out here.
    this.clearAttention();
    this.state.phase = phase;
    this.state.atGate = phase.endsWith("-gate");
    if (!this.state.atGate) this.state.gate = null;
    this.post({ type: "gateDone" });
    this.postState();
    void this.resync();
  }

  /**
   * A refused approval. A 409 carrying `failed` means the checks did not pass: they are shown,
   * and nothing is retried. "Approve anyway" exists only as a separate, explicit act with a reason.
   */
  private gateRefused(err: unknown, action: "approve" | "reject"): void {
    if (err instanceof NeoHttpError && err.detail && typeof err.detail === "object" && !Array.isArray(err.detail)) {
      const d = err.detail as { error?: string; failed?: unknown; artifact_missing?: boolean; confirmable?: boolean };
      this.post({
        type: "gateRefused",
        message: d.error ?? err.message,
        failed: Array.isArray(d.failed) ? d.failed : [],
        confirmable: Boolean(d.confirmable),
        artifactMissing: Boolean(d.artifact_missing),
        detail: err.technical(),
      });
      void this.resync();
    } else if (err instanceof NeoHttpError && err.status < 500) {
      // NEO's own refusal, in its words (e.g. the project is no longer at this gate).
      this.post({ type: "gateRefused", message: err.message, failed: [], confirmable: false, detail: err.technical() });
      void this.resync();
    } else {
      // Not a refusal: NEO could not be reached or failed. Nothing is retried; the card stays usable.
      this.post({ type: "gateFailed", ...this.actionFailed(err, action) });
    }
  }

  /**
   * Stop: NEO's own abort, nothing added to it.
   *
   * The turn NEO is running is ended. Nothing already written is undone and the phase does not
   * move — so the sidebar says "stopping" until NEO reports it is no longer busy, and then
   * "stopped", rather than claiming the abort landed the moment the request returned.
   */
  private async abort(): Promise<void> {
    const project = this.state.project;
    if (!project || this.state.stopping) return;
    if (!this.confirmReady()) return;
    this.state.stopping = true;
    this.stopRequestedAt = Date.now();
    this.state.stoppedAt = undefined;
    this.postState();
    try {
      await this.client.abort(project.id);
      // Not finished yet: `stopping` clears when NEO reports busy = false (settleStopping).
      void this.resync();
    } catch (err) {
      this.state.stopping = false;
      this.stopRequestedAt = 0;
      this.postState();
      this.postProblem(this.actionFailed(err, "abort"));
    }
  }

  /**
   * Close out a Stop. NEO going quiet is what ends it; the timeout is only so the sidebar cannot
   * be left saying "stopping" forever if NEO never reports the turn ending.
   */
  private settleStopping(): void {
    const s = this.state;
    if (!s.stopping) return;
    const timedOut = this.stopRequestedAt > 0 && Date.now() - this.stopRequestedAt > STOP_SETTLE_MS;
    if (s.busy && !timedOut) return;
    s.stopping = false;
    this.stopRequestedAt = 0;
    if (!s.busy) {
      s.stoppedAt = Date.now();
      // NEO confirmed the turn ended after the user's Stop: what it says about that turn next is the Stop.
      s.userStopped = true;
      this.action.reset();
    }
  }

  /**
   * Create a project in the open folder through NEO's existing API, then start it.
   *
   * NEO decides where a new project lives (`projects_root/<slug>`); this extension cannot point it
   * at a folder. So the demo runs NEO with NEOAG_PROJECTS_ROOT set to this folder's parent, and
   * this method refuses anything that would make NEO build somewhere other than the open folder —
   * and if NEO does anyway, it reports that and does not start the project.
   */
  private async createProject(name: string, idea: string, interaction: string): Promise<void> {
    const folder = this.state.folder;
    name = (name ?? "").trim();
    idea = (idea ?? "").trim();
    const fail = (message: string, problem?: Problem) =>
      this.post({ type: "newProjectFailed", message, hint: problem?.hint, detail: problem?.detail });
    if (this.state.connection !== "connected") {
      return fail(`NEO is offline (${this.client.baseUrl}). Start the NEO server, press Retry, then create the project.`);
    }
    if (!folder) return fail("Open a folder first: the project is created in the open folder.");
    if (this.folderIsSelectedProject()) {
      return fail(`This folder is already the NEO project “${this.state.project!.name}”.`);
    }
    if (!name) return fail("Give the project a name.");
    if (!idea) return fail("Describe what you want built.");
    if (normalizePath(neoSlug(name)) !== normalizePath(path.basename(folder))) {
      return fail(
        `NEO would name this project's folder “${neoSlug(name)}”, but the open folder is ` +
          `“${path.basename(folder)}”. Use the folder's name as the project name.`,
      );
    }
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(folder);
    } catch {
      /* unreadable: let NEO report it */
    }
    if (entries.length) {
      return fail(
        `The open folder is not empty (${entries.slice(0, 3).join(", ")}${entries.length > 3 ? ", …" : ""}). ` +
          "NEO creates a new project only in an empty folder.",
      );
    }
    if (!["max", "high", "normal", "low"].includes(interaction)) interaction = "normal";

    let created;
    try {
      created = await this.client.createProject({
        name,
        entry_type: "new",
        idea,
        interaction: interaction as "normal",
      });
    } catch (err) {
      // Not retried: a project that was created must not be created twice. Projects shows which.
      const problem = this.actionFailed(err, "createProject", false);
      return fail(problem.summary, problem);
    }
    if (!samePath(created.path, folder)) {
      this.post({
        type: "newProjectFailed",
        message:
          `NEO registered “${created.name}” at ${created.path}, not in this folder, so it was NOT ` +
          `started. Restart NEO with NEOAG_PROJECTS_ROOT set to ${path.dirname(folder)} (see the ` +
          "extension README), or open that folder instead.",
        openPath: created.path,
      });
      return;
    }
    try {
      await this.client.start(created.id, idea);
    } catch (err) {
      // The project exists either way; the message box starts it (send() on a setup project).
      const problem = this.actionFailed(err, "startProject", false);
      if (!(err instanceof NeoUnreachable && err.maybeDelivered)) problem.hint = "Send your request in the message box to start it.";
      this.postProblem(problem);
    }
    this.post({ type: "projectCreated" });
    const gen = ++this.generation;
    this.stopProject();
    await this.loadProject(created.id, gen);
  }

  // --- helpers ----------------------------------------------------------------------------

  /**
   * A failed read. Unreachable: the offline state (or "Reconnecting…" with a project open). Anything
   * else: with a project on screen, a toast with its details; with nothing on screen, the empty state
   * says what failed, with Retry.
   */
  private fail(err: unknown, action: ErrorAction): void {
    if (this.state.mode === "loading") this.state.mode = this.state.project ? "project" : "noProject";
    const shown = describeError(err, action);
    if (shown.offline) {
      this.wentOffline(err, shown);
      return;
    }
    logError(shown);
    if (this.state.mode === "project") this.postProblem(problemOf(shown));
    else this.state.problem = problemOf(shown);
    this.postState();
  }

  /**
   * A user action NEO did not confirm. What it means goes back to the caller to show; NEO being
   * unreachable is noted as a lost connection; otherwise the state is re-read once (a read, so safe)
   * in case the action landed or the state moved. The action itself is never repeated.
   */
  private actionFailed(err: unknown, action: ErrorAction, reread = true): Problem & { message: string } {
    const shown = describeError(err, action);
    logError(shown);
    if (shown.offline) {
      if (this.state.project && this.state.mode === "project") this.noteDown(err);
      else this.wentOffline(err, shown);
    } else if (reread) {
      void this.resync();
    }
    return { ...problemOf(shown), message: shown.summary };
  }

  /** An error toast: the summary, what to do, and the details one click away. */
  private postProblem(p: Problem): void {
    this.post({ type: "toast", level: "error", text: p.summary, hint: p.hint, detail: p.detail, settings: p.config });
  }

  private blankState(connection: Connection): ViewState {
    return {
      serverHost: hostOf(this.client.baseUrl),
      serverUrl: this.client.baseUrl,
      connection,
      retrying: false,
      ready: false,
      stream: "off",
      mode: "loading",
      stages: [],
      busy: false,
      atGate: false,
      gate: null,
      awaiting: false,
      pendingRequest: null,
      needsAttention: false,
      attentionReason: null,
      planProgress: null,
      stopping: false,
      userStopped: false,
      catchingUp: false,
      attachments: [],
      suggestion: null,
    };
  }

  private postState(): void {
    this.state.ready = this.isReady();
    this.state.attachments = this.attachments.map(viewOf);
    this.state.suggestion = this.state.mode === "project" ? this.suggestion() : null;
    this.settleStopping();
    // NEO's count - or, once Execute is over and NEO's has dropped, the furthest one remembered.
    const plan = this.plan.view(this.state.planProgress, this.state.phase, this.lastSeq);
    // Before the state goes out: unseen activity on screen now is summarised, then marked seen.
    if (this.state.mode === "project") this.sessions.sync(this.lastSeq, this.state, plan.progress);
    this.state.sessions = this.state.mode === "project" ? this.sessions.view() : undefined;
    this.state.live = buildLive(
      { ...this.state, planProgress: plan.progress },
      plan.task,
      this.action.current(),
      liveNotice(this.notice, this.state.busy),
    );
    this.changes.update(this.state.mode === "project" ? this.state.project : undefined, this.state.phase);
    this.state.artifacts = this.artifacts.build({ ...this.state, stages: this.state.stages as StageLike[] });
    this.post({ type: "state", state: this.state });
    this.syncContextKeys();
  }

  /** Mirror the state into the context keys the view title's actions depend on. */
  private syncContextKeys(): void {
    const s = this.state;
    const hasProject = s.mode === "project" && Boolean(s.project);
    const connected = s.connection === "connected";
    const keys: NeoContextKeys = {
      "neo.hasProject": hasProject,
      "neo.busy": hasProject && connected && s.busy && !s.stopping,
      "neo.sessionDone": hasProject && connected && !s.busy && s.phase === "done",
    };
    for (const key of Object.keys(keys) as (keyof NeoContextKeys)[]) {
      if (this.contextKeys[key] === keys[key]) continue;
      this.contextKeys[key] = keys[key];
      void vscode.commands.executeCommand("setContext", key, keys[key]);
    }
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", file));
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("chat.css")}">
<link rel="stylesheet" href="${media("progress.css")}">
<link rel="stylesheet" href="${media("changes.css")}">
<link rel="stylesheet" href="${media("plan.css")}">
<link rel="stylesheet" href="${media("sessions.css")}">
<title>NEO</title>
</head>
<body>
<div id="app">
  <header id="header">
    <div class="row">
      <span class="title" title="NEO · Powered by CodeValue">
        ${BRAND_MARK}
        <span class="brand-name">NEO</span>
        <span id="title-sep" class="title-sep hidden">·</span>
        <span id="project-name" class="project-name"></span>
      </span>
      <span class="tools">
        <button id="act-projects" class="icon" type="button" title="Projects: switch to another NEO project" aria-label="Projects">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.6" cy="4" r=".8" fill="currentColor"/><circle cx="2.6" cy="8" r=".8" fill="currentColor"/><circle cx="2.6" cy="12" r=".8" fill="currentColor"/></svg>
        </button>
        <button id="act-new" class="icon" type="button" title="New Project in the open folder" aria-label="New Project">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
        </button>
        <button id="act-web" class="icon" type="button" title="Open the NEO Web UI" aria-label="Open Web UI">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7"/></svg>
        </button>
      </span>
    </div>
    <div class="row status-row">
      <span id="conn" class="conn"><span class="dot"></span><span id="conn-text">Connecting…</span></span>
    </div>
    <div id="rail" class="rail hidden"></div>
    <!-- Live progress: current plan task, plan progress, current action, and the one line that
         says whether NEO is stalled, stopped or reconnecting. Owned by media/progress.js. -->
    <div id="live" class="live hidden" aria-live="polite"></div>
    <!-- The Design and Plan documents and where each stands. Owned by media/plan.js. -->
    <div id="artifacts" class="artifacts hidden"></div>
  </header>

  <section id="banner" class="banner hidden"></section>

  <section id="new-project" class="card new-project hidden">
    <h3>New NEO project</h3>
    <p class="muted" id="np-folder"></p>
    <label>Name <input id="np-name" type="text" spellcheck="false"></label>
    <label>What do you want built?
      <textarea id="np-idea" rows="6" placeholder="Describe the project. This is the request NEO extracts the requirements from."></textarea>
    </label>
    <label>Interaction
      <select id="np-interaction">
        <option value="normal" selected>normal</option>
        <option value="high">high</option>
        <option value="max">max</option>
        <option value="low">low (merge gate may approve itself)</option>
      </select>
    </label>
    <div id="np-error" class="error-text"></div>
    <div class="buttons">
      <button id="np-create" class="primary">Create and start</button>
      <button id="np-cancel" class="secondary">Cancel</button>
    </div>
  </section>

  <!-- "Since you were away": what NEO stored after the user last saw this project. Owned by media/sessions.js. -->
  <section id="away" class="card away hidden" aria-live="polite"></section>

  <main id="transcript" class="transcript" aria-live="polite"></main>

  <section id="changes" class="changes hidden" aria-label="Files NEO changed"></section>

  <section id="gate" class="card gate hidden">
    <div class="gate-head">
      <span class="gate-badge">Gate</span>
      <strong id="gate-title"></strong>
    </div>
    <div class="muted small">phase <code id="gate-phase"></code> · <code id="gate-path"></code></div>
    <div id="gate-artifact" class="gate-artifact hidden"></div>
    <details id="gate-doc" class="gate-doc">
      <summary id="gate-doc-summary">document</summary>
      <div id="gate-doc-body" class="md"></div>
    </details>
    <div id="gate-changes" class="gate-changes hidden"></div>
    <ul id="gate-checks" class="checks"></ul>
    <div id="gate-refusal" class="refusal hidden"></div>
    <textarea id="gate-text" rows="3" placeholder="What should change? (required for Request Changes)"></textarea>
    <div id="gate-error" class="error-text"></div>
    <div class="buttons">
      <button id="gate-approve" class="primary">Approve</button>
      <button id="gate-reject" class="secondary">Request Changes</button>
      <button id="gate-anyway" class="danger hidden">Approve anyway</button>
    </div>
  </section>

  <form id="composer" class="composer">
    <div class="input-box">
      <div id="context-row" class="context-row hidden" aria-label="Context attached to this message"></div>
      <textarea id="message" rows="2" placeholder="Message NEO…" aria-label="Message NEO"></textarea>
      <div class="input-bar">
        <button id="add-context" class="icon add-context" type="button" title="Add context: current file, selection, or a workspace file (or type @)" aria-label="Add context">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
        </button>
        <span id="composer-status" class="composer-status"></span>
        <span id="send-hint" class="send-hint">Ctrl+Enter</span>
        <button id="abort" type="button" class="stop hidden" title="Abort the running turn">
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg><span id="abort-label">Stop</span>
        </button>
        <button id="send" type="submit" class="send" title="Send (Ctrl+Enter)" aria-label="Send">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>
          <span class="send-label">New session</span>
        </button>
      </div>
    </div>
  </form>
  <div id="toasts" class="toasts"></div>
</div>
<script nonce="${nonce}" src="${media("progress.js")}"></script>
<script nonce="${nonce}" src="${media("chat.js")}"></script>
<script nonce="${nonce}" src="${media("changes.js")}"></script>
<script nonce="${nonce}" src="${media("plan.js")}"></script>
<script nonce="${nonce}" src="${media("sessions.js")}"></script>
</body>
</html>`;
  }
}

// The NEO hexagon mark, inline so it follows the theme colour. Reused by the empty state (chat.js
// clones it from the header).
const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2.2 20.5 7.1v9.8L12 21.8 3.5 16.9V7.1Z" stroke-width="1.8"/>
          <path d="M8.6 15.6V8.4l6.8 7.2V8.4" stroke-width="2.1"/>
        </svg>`;

function serverUrl(): string {
  const raw = vscode.workspace.getConfiguration("neo").get<string>("serverUrl") || "http://127.0.0.1:8720";
  return raw.replace(/\/+$/, "");
}

function maxSeq(events: NeoEvent[], floor: number): number {
  return events.reduce((m, e) => (typeof e.seq === "number" && e.seq > m ? e.seq : m), floor);
}

function problemOf(e: ErrorView): Problem {
  return { summary: e.summary, hint: e.hint, detail: e.detail, config: e.config || undefined };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
