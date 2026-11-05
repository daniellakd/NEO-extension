import * as vscode from "vscode";
import {
  GateEvent,
  NeoClient,
  NeoEvent,
  NeoSession,
  ProjectDetail,
  SessionKind,
  hostOf,
} from "./neoClient";
import {
  AwaySummary,
  NowInput,
  SeenAnchor,
  anchorKey,
  awaySummary,
  covers,
  kindLabel,
  maxGateAt,
  sessionMarkdown,
} from "./sessionHistory";

/**
 * Sessions, history and resume for the sidebar (the pure rules are in src/sessionHistory.ts).
 *
 *   - which NEO session is active, and the earlier ones, from NEO's own session records;
 *   - "since you were away": what NEO stored after the last event the user had on screen;
 *   - NEO: Sessions, a QuickPick of the project's sessions, each opened as a read-only Markdown
 *     snapshot under the `neo-session:` scheme.
 *
 * Read-only throughout. Nothing here calls anything but NEO's GET routes, and the snapshot viewer
 * has no connection to the sidebar's project, stream or state: it reads the session named in its
 * own URI and nothing else, so looking at an old session can never make it active or start work.
 */

export const SCHEME = "neo-session";

// The most events read to cover a long absence (NEO's own cap for one history read).
const GAP_READ = 2000;
// The unseen buffer's bound; past it the summary says its counts are minimums.
const UNSEEN_CAP = 5000;
// The anchor is written at most this often while events stream past a visible sidebar.
const WRITE_MS = 1000;

export interface SessionsHost {
  client(): NeoClient;
  store: vscode.Memento | undefined;
  /** Repaint: posts the state again. */
  changed(): void;
  /** The transcript is on screen: the sidebar is visible and the window has focus. */
  viewed(): boolean;
  projectName(): string | undefined;
}

/** One session as the webview draws it. */
export interface SessionRow {
  id: string;
  title: string;
  kind: string;
  index: number;
  count: number;
  createdAt: number;
  endedAt: number | null;
  firstEvent: number | null;
  active: boolean;
}

export interface SessionsView {
  /** NEO reports sessions (versions before sessions do not). */
  supported: boolean;
  active: SessionRow | null;
  list: SessionRow[];
  /** Events of the active session NEO has but the sidebar did not load. */
  hiddenEarlier: number;
  away: AwaySummary | null;
  /** The first event new since the last visit: where the transcript's divider goes. */
  newFrom: number | null;
}

export type SessionsMessage =
  | { type: "sessions.pick" }
  | { type: "sessions.open"; id?: string }
  | { type: "sessions.dismiss" };

export class SessionsController implements vscode.Disposable {
  private projectId: string | undefined;
  private key: string | undefined;
  private sessions: NeoSession[] | undefined;
  private activeId: string | null = null;
  private kinds: Record<string, SessionKind> = {};
  private gateEvents: GateEvent[] = [];
  private hiddenEarlier = 0;

  // Since you were away.
  private anchor: SeenAnchor | undefined;
  /** The unseen buffer is complete enough to summarise. Until then nothing is marked as seen. */
  private ready = false;
  private unseen: NeoEvent[] = [];
  private complete = true;
  private trigger: "open" | "return" = "open";
  private away: AwaySummary | null = null;
  private newFrom: number | null = null;
  private token = 0;
  private writeTimer: NodeJS.Timeout | undefined;
  private lastWrite = 0;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly host: SessionsHost) {
    const provider: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: (uri) => this.document(uri),
    };
    this.disposables.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider));
    // Coming back to the window is when unseen activity becomes seen; repaint so it is noticed.
    const onWindow = (vscode.window as { onDidChangeWindowState?: vscode.Event<vscode.WindowState> }).onDidChangeWindowState;
    if (onWindow) this.disposables.push(onWindow(() => this.host.changed()));
  }

  dispose(): void {
    this.close();
    this.disposables.forEach((d) => d.dispose());
  }

  // --- project lifecycle (called by the sidebar) ------------------------------------------

  /**
   * A project was opened, `detail` its first read. The last-seen anchor is read now and nothing is
   * marked as seen until every event since it has been gathered - so reopening VS Code cannot
   * swallow what happened while it was closed before it has been summarised.
   */
  open(projectId: string, detail: ProjectDetail): void {
    this.close();
    const token = ++this.token;
    this.projectId = projectId;
    this.key = anchorKey(hostOf(this.host.client().baseUrl), projectId);
    this.noteDetail(detail);
    const shown = typeof detail.history_shown === "number" ? detail.history_shown : detail.history.length;
    this.hiddenEarlier = Math.max(0, (detail.history_total ?? 0) - shown);
    this.anchor = this.host.store?.get<SeenAnchor>(this.key);
    this.trigger = "open";
    if (!this.anchor) {
      this.ready = true;
      return;
    }
    const anchorSeq = this.anchor.seq;
    this.unseen = detail.history.filter((e) => typeof e.seq === "number" && e.seq > anchorSeq);
    this.complete = covers(anchorSeq, detail.history, detail.history_total ?? 0, shown);
    if (this.complete) {
      this.ready = true;
      return;
    }
    // A long absence: read further back, once, before saying anything.
    void (async () => {
      try {
        const more = await this.host.client().project(projectId, GAP_READ);
        if (token !== this.token) return;
        const moreShown = typeof more.history_shown === "number" ? more.history_shown : more.history.length;
        const seen = new Set(this.unseen.map((e) => e.seq));
        const older = more.history.filter((e) => typeof e.seq === "number" && e.seq > anchorSeq && !seen.has(e.seq));
        this.unseen = [...older, ...this.unseen];
        this.complete = covers(anchorSeq, more.history, more.history_total ?? 0, moreShown);
      } catch {
        // Counted as incomplete: the summary says its counts are minimums.
      } finally {
        if (token === this.token) {
          this.ready = true;
          this.host.changed();
        }
      }
    })();
  }

  /** The project is closed (switch, refresh, reconnect from scratch): keep what was seen. */
  close(): void {
    this.flush();
    this.token++;
    this.projectId = undefined;
    this.key = undefined;
    this.sessions = undefined;
    this.activeId = null;
    this.gateEvents = [];
    this.hiddenEarlier = 0;
    this.anchor = undefined;
    this.ready = false;
    this.unseen = [];
    this.complete = true;
    this.away = null;
    this.newFrom = null;
  }

  /** Any project read: NEO's session records and gate decisions, as they are now. */
  noteDetail(d: ProjectDetail): void {
    if (Array.isArray(d.sessions)) {
      this.sessions = d.sessions.map(slimSession);
      this.activeId = d.session_id ?? this.sessions[this.sessions.length - 1]?.id ?? null;
    }
    if (Array.isArray(d.gate_events)) {
      this.gateEvents = d.gate_events.map((g) => ({ phase: g.phase, action: g.action, feedback: g.feedback, created_at: g.created_at }));
    }
  }

  /** A persisted event the sidebar delivered (already de-duplicated by seq). */
  noteEvent(ev: NeoEvent): void {
    if (!this.projectId || typeof ev.seq !== "number") return;
    if (this.anchor && ev.seq <= this.anchor.seq) return;
    this.unseen.push(ev);
    if (this.unseen.length > UNSEEN_CAP) {
      this.unseen.splice(0, this.unseen.length - UNSEEN_CAP);
      this.complete = false;
    }
  }

  /**
   * Called on every repaint, before the state is posted. When the transcript is on screen and the
   * unseen events are all gathered: summarise them (if they are worth it), then mark them seen.
   */
  sync(lastSeq: number, now: NowInput, plan: { done: number; total: number } | null): void {
    if (!this.projectId || !this.key || !this.ready || !this.host.viewed()) return;
    const a = this.anchor;
    const gateAt = maxGateAt(this.gateEvents);
    const pending =
      !a || this.unseen.length > 0 || a.session !== this.activeId || gateAt > a.gateAt || a.seq > lastSeq || planMoved(a.plan, plan);
    if (pending) {
      const summary = awaySummary({
        trigger: this.trigger,
        anchor: a,
        events: this.unseen,
        complete: this.complete,
        newestSeq: lastSeq,
        sessions: this.sessions,
        activeSession: this.activeId,
        kinds: this.kinds,
        gateEvents: this.gateEvents,
        plan,
        now,
      });
      if (summary) {
        this.away = summary;
        if (summary.firstNewSeq !== null) this.newFrom = summary.firstNewSeq;
      }
    }
    // From here on, anything new arrived while the project was open: only a change of picture
    // (a gate, a question, a new session…) is worth a card.
    this.trigger = "return";
    this.unseen = [];
    this.complete = true;
    const next: SeenAnchor = { seq: lastSeq, session: this.activeId, gateAt, plan: plan ? { ...plan } : null, at: Date.now() };
    const moved = !a || a.seq !== next.seq || a.session !== next.session || a.gateAt !== next.gateAt || planMoved(a.plan, next.plan);
    this.anchor = next;
    if (moved || next.at - this.lastWrite > 60_000) this.write();
  }

  view(): SessionsView {
    const rows = (this.sessions ?? []).map((s, i, all) => this.row(s, i, all.length));
    return {
      supported: this.sessions !== undefined,
      active: rows.find((r) => r.active) ?? null,
      list: rows,
      hiddenEarlier: this.hiddenEarlier,
      away: this.away,
      newFrom: this.newFrom,
    };
  }

  /** The stored anchor for the open project, for tests and diagnostics. */
  stored(): SeenAnchor | undefined {
    return this.key ? this.host.store?.get<SeenAnchor>(this.key) : undefined;
  }

  async onMessage(m: SessionsMessage): Promise<void> {
    switch (m.type) {
      case "sessions.pick":
        return this.pick();
      case "sessions.open":
        if (m.id) await this.openSnapshot(m.id);
        return;
      case "sessions.dismiss":
        this.away = null;
        this.host.changed();
        return;
    }
  }

  // --- NEO: Sessions ----------------------------------------------------------------------

  /** The project's sessions, newest first; the one picked opens read-only. Never changes the active one. */
  async pick(): Promise<void> {
    const projectId = this.projectId;
    if (!projectId) {
      void vscode.window.showInformationMessage("NEO: open a NEO project first to see its sessions.");
      return;
    }
    let list: NeoSession[];
    try {
      const data = await this.host.client().sessions(projectId);
      list = data.sessions;
      this.kinds = data.kinds;
    } catch (err) {
      void vscode.window.showErrorMessage(`NEO: could not read the sessions: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (projectId !== this.projectId) return;
    if (!list.length) {
      void vscode.window.showInformationMessage("NEO has no sessions recorded for this project yet.");
      return;
    }
    const active = list[list.length - 1].id;
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = list
      .map((s, i) => {
        const isActive = s.id === active;
        const state = isActive ? "active" : s.ended_at ? `ended ${shortTime(s.ended_at)}` : "not active";
        const facts = [`started ${shortTime(s.created_at)}`];
        if (typeof s.messages === "number") facts.push(`${s.messages} message${s.messages === 1 ? "" : "s"}`);
        const request = firstLine(s.request);
        if (request) facts.push(request);
        return {
          id: s.id,
          label: `${isActive ? "$(circle-filled)" : "$(history)"} ${s.title}`,
          description: `${i + 1} of ${list.length} · ${kindLabel(s.kind, this.kinds)} · ${state}`,
          detail: facts.join(" · "),
        };
      })
      .reverse();
    const picked = await vscode.window.showQuickPick(items, {
      title: "NEO sessions",
      placeHolder: "Open a session as a read-only snapshot (the active session is not changed)",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked) await this.openSnapshot(picked.id);
  }

  /** The read-only document for one session, in the Markdown preview. */
  async openSnapshot(sessionId: string): Promise<void> {
    const projectId = this.projectId;
    if (!projectId) return;
    const uri = snapshotUri(projectId, sessionId, this.host.projectName() ?? projectId);
    try {
      await vscode.commands.executeCommand("markdown.showPreview", uri);
    } catch {
      // The built-in Markdown extension is disabled: show the source, which is just as read-only.
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  }

  /**
   * The snapshot's content. Everything comes from the URI and NEO's GET routes; the sidebar's
   * project, stream and state are not consulted and not touched.
   */
  async document(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const projectId = q.get("project") ?? "";
    const sessionId = q.get("session") ?? "";
    if (!projectId || !sessionId) return "# Session unavailable\n\nThis link does not name a NEO project and session.\n";
    try {
      const client = this.host.client();
      const [detail, listed] = await Promise.all([client.project(projectId, GAP_READ, sessionId), client.sessions(projectId)]);
      const all = listed.sessions;
      const index = all.findIndex((s) => s.id === sessionId);
      if (index < 0) return "# Session unavailable\n\nNEO has no such session in this project.\n";
      return sessionMarkdown({
        projectName: detail.project?.name ?? projectId,
        session: all[index],
        index: index + 1,
        count: all.length,
        active: index === all.length - 1,
        kinds: listed.kinds,
        events: detail.history ?? [],
        total: detail.history_total ?? (detail.history ?? []).length,
        shown: typeof detail.history_shown === "number" ? detail.history_shown : (detail.history ?? []).length,
        gateEvents: detail.gate_events,
        stages: detail.stages,
        takenAt: Date.now() / 1000,
      });
    } catch (err) {
      return `# Session unavailable\n\nNEO could not be read: ${err instanceof Error ? err.message : String(err)}\n`;
    }
  }

  // --- helpers ----------------------------------------------------------------------------

  private row(s: NeoSession, i: number, count: number): SessionRow {
    return {
      id: s.id,
      title: s.title,
      kind: kindLabel(s.kind, this.kinds),
      index: i + 1,
      count,
      createdAt: s.created_at,
      endedAt: s.ended_at ?? null,
      firstEvent: typeof s.first_event === "number" ? s.first_event : null,
      active: s.id === this.activeId,
    };
  }

  /** Write the anchor soon: at most once a second while events stream past. */
  private write(): void {
    if (this.writeTimer) return;
    const wait = Math.max(0, WRITE_MS - (Date.now() - this.lastWrite));
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    if (!this.key || !this.anchor || !this.ready) return;
    // The anchor in memory differs from the stored one only once `sync` ran with the transcript on
    // screen: one merely read at open is never written back.
    const stored = this.host.store?.get<SeenAnchor>(this.key);
    if (stored && JSON.stringify(stored) === JSON.stringify(this.anchor)) return;
    this.lastWrite = Date.now();
    void this.host.store?.update(this.key, this.anchor);
  }
}

function slimSession(s: NeoSession): NeoSession {
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    request: s.request,
    created_at: s.created_at,
    ended_at: s.ended_at ?? null,
    messages: s.messages,
    events: s.events,
    first_event: s.first_event ?? null,
    last_event: s.last_event ?? null,
  };
}

function planMoved(a: { done: number; total: number } | null | undefined, b: { done: number; total: number } | null | undefined): boolean {
  if (!a || !b) return false;
  return a.done !== b.done || a.total !== b.total;
}

export function snapshotUri(projectId: string, sessionId: string, projectName: string): vscode.Uri {
  const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
  const query = new URLSearchParams({ project: projectId, session: sessionId, t: String(Date.now()) }).toString();
  return vscode.Uri.from({ scheme: SCHEME, path: `/${slug(projectName)}/session-${slug(sessionId)}.md`, query });
}

function shortTime(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || seconds <= 0) return "—";
  const d = new Date(seconds * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  const today = new Date();
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === today.toDateString()) return `today ${time}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`;
}

function firstLine(text: string | null | undefined): string {
  const line = String(text ?? "")
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
