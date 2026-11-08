// A mock NEO backend for the provider tests: the endpoints and SSE framing the extension uses, with
// the response shapes of orchestrator/neoag/app.py. In memory; it records calls and open streams.
import * as http from "http";

export interface MockProject {
  id: string;
  name: string;
  path: string;
  phase: string;
  busy: boolean;
  at_gate: boolean;
  gate: unknown;
  awaiting_answer: boolean;
  pending_request: string | null;
  needs_attention: boolean;
  attention_reason: string | null;
  plan_progress: { done: number; total: number } | null;
  history: Record<string, unknown>[];
  /** NEO work sessions, oldest first. Unset: a NEO without sessions (the detail has no `sessions`). */
  sessions?: Record<string, unknown>[];
  gate_events?: Record<string, unknown>[];
}

// NEO's SESSION_KINDS (orchestrator phases.py): what each kind is called and the phase it starts in.
const MOCK_KINDS: Record<string, { label: string; description: string; phase: string }> = {
  full: { label: "Full pipeline", description: "Interview, design, plan, TDD, review — every gate.", phase: "brainstorm" },
  prd: { label: "Quick plan", description: "A short plan, approved once, then built.", phase: "plan" },
  quick: { label: "Quick change", description: "Straight to the work, reviewed at the end.", phase: "execute" },
};

export class MockNeo {
  readonly projects = new Map<string, MockProject>();
  readonly calls: string[] = [];
  /** The bodies of the POSTs that carry one (new sessions). */
  readonly posts: { path: string; body: Record<string, unknown> }[] = [];
  readonly maxStreams = new Map<string, number>();
  refuseStreams = false;
  /** Holds a project read until it resolves (tests that need a read still in flight). */
  holdRead: ((history: number) => Promise<void> | undefined) | null = null;
  private readonly streams = new Map<string, Set<http.ServerResponse>>();
  private seq = 1000;
  private readonly server = http.createServer((req, res) => this.handle(req, res));

  listen(): Promise<string> {
    return new Promise((resolve) =>
      this.server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(this.server.address() as { port: number }).port}`)),
    );
  }

  close(): Promise<void> {
    for (const set of this.streams.values()) for (const r of set) r.destroy();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  add(p: Partial<MockProject> & { id: string; path: string }): MockProject {
    const project: MockProject = {
      name: p.id, phase: "execute", busy: false, at_gate: false, gate: null, awaiting_answer: false, pending_request: null,
      needs_attention: false, attention_reason: null, plan_progress: null, history: [], ...p,
    };
    this.projects.set(p.id, project);
    return project;
  }

  /** A persisted event: it gets a seq, goes into the history and out on every open stream. */
  emit(id: string, ev: Record<string, unknown>): Record<string, unknown> {
    const e = this.record(id, ev);
    this.push(id, e);
    return e;
  }

  /** Persisted while nobody is listening: only a catch-up can deliver it. */
  record(id: string, ev: Record<string, unknown>): Record<string, unknown> {
    const p = this.projects.get(id)!;
    const e = { ...ev, seq: ++this.seq };
    p.history.push(e);
    // Filed under the newest session, as NEO's append_stream_event does with work_session_id.
    const current = p.sessions?.[p.sessions.length - 1];
    if (current) {
      if (current.first_event === null || current.first_event === undefined) current.first_event = e.seq;
      current.last_event = e.seq;
      (e as Record<string, unknown>).__session = current.id;
    }
    return e;
  }

  /** A new session, as POST /sessions makes one: the previous one ends. */
  startSession(id: string, s: { id: string; kind?: string; title?: string; request?: string; created_at?: number }): Record<string, unknown> {
    const p = this.projects.get(id)!;
    p.sessions ??= [];
    const now = Date.now() / 1000;
    const last = p.sessions[p.sessions.length - 1];
    if (last && !last.ended_at) last.ended_at = s.created_at ?? now;
    const session = { kind: "full", title: s.id, request: null, created_at: now, ended_at: null, first_event: null, last_event: null, messages: 0, ...s };
    p.sessions.push(session);
    return session;
  }

  /** A live-only event, like NEO's `persist=False` emits (the status after an abort): no seq, no history. */
  emitLive(id: string, ev: Record<string, unknown>): void {
    this.push(id, ev);
  }

  /** Drop every open stream of a project, as a network blip would. */
  drop(id: string): void {
    for (const r of this.streams.get(id) ?? []) r.destroy();
  }

  open(id: string): number {
    return this.streams.get(id)?.size ?? 0;
  }

  private push(id: string, ev: Record<string, unknown>): void {
    for (const r of this.streams.get(id) ?? []) r.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  private detail(p: MockProject, history: number, session?: string): Record<string, unknown> {
    // NEO's stream_tail: one session's events (the newest also adopts untagged ones), capped at 2000.
    const newest = p.sessions?.[p.sessions.length - 1]?.id as string | undefined;
    const chosen = session ?? newest;
    const events = p.sessions
      ? p.history.filter((e) => e.__session === chosen || (chosen === newest && e.__session === undefined))
      : p.history;
    const limit = Math.max(1, Math.min(history, 2000));
    const shown = events.slice(-limit).map(({ __session, ...e }) => e);
    // NEO's db.phase_marks: where each phase began in the chosen session ("done" once it finished).
    const marks: Record<string, number> = {};
    for (const e of events) {
      if (e.kind === "phase" && typeof e.phase === "string" && !(e.phase in marks)) marks[e.phase] = e.seq as number;
    }
    return {
      phase_marks: marks,
      project: { id: p.id, name: p.name, path: p.path, phase: p.phase, entry_type: "new", idea: "A todo CLI" },
      phase: p.phase, at_gate: p.at_gate, session_id: p.sessions ? chosen ?? null : "ses", gate: p.gate, busy: p.busy, awaiting_answer: p.awaiting_answer,
      pending_request: p.pending_request, needs_attention: p.needs_attention, attention_reason: p.attention_reason,
      plan_progress: p.plan_progress, stages: [], path_missing: false,
      history: shown, history_total: events.length, history_shown: shown.length,
      ...(p.sessions ? { sessions: p.sessions.map((s) => ({ ...s })), gate_events: p.gate_events ?? [] } : {}),
    };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    this.calls.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/debug/status") return json(200, { opencode_reachable: true });
    if (url.pathname === "/api/projects" && req.method === "GET") {
      return json(200, { projects: [...this.projects.values()].map((p) => ({ id: p.id, name: p.name, path: p.path, phase: p.phase, entry_type: "new" })) });
    }
    const m = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const p = m ? this.projects.get(m[1]) : undefined;
    if (!m || !p) return json(404, { detail: "not found" });
    const sub = m[2] ?? "";
    if (sub === "" && req.method === "GET") {
      const session = url.searchParams.get("session") ?? undefined;
      if (session && !p.sessions?.some((s) => s.id === session)) return json(404, { detail: "no such session in this project" });
      const history = Number(url.searchParams.get("history") ?? 0);
      const held = this.holdRead?.(history);
      if (held) {
        void held.then(() => json(200, this.detail(p, history, session)));
        return;
      }
      return json(200, this.detail(p, history, session));
    }
    if (sub === "/sessions" && req.method === "GET") {
      if (!p.sessions) return json(404, { detail: "not found" });
      return json(200, { sessions: p.sessions, kinds: MOCK_KINDS });
    }
    if (sub === "/sessions" && req.method === "POST") {
      // NEO's start_session: refused while the agent works or for an unknown kind; otherwise the
      // current session ends, a new one starts at its kind's first phase, and its kickoff is sent.
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { kind?: string; request?: string; title?: string };
        this.posts.push({ path: sub, body });
        const kind = MOCK_KINDS[body.kind ?? "quick"];
        if (!kind) return json(422, { detail: `unknown session kind '${body.kind}'` });
        if (p.busy) return json(409, { detail: "the agent is still working — wait for this session to finish" });
        const session = this.startSession(p.id, {
          id: `s${(p.sessions?.length ?? 0) + 1}-new`,
          kind: body.kind ?? "quick",
          title: body.title || String(body.request ?? "").split("\n")[0].slice(0, 60),
          request: body.request,
        });
        p.phase = kind.phase;
        this.emit(p.id, { kind: "phase", phase: kind.phase, session: session.id });
        this.emit(p.id, { kind: "user", note: "new session", text: `Here is what I want:\n\n${body.request}` });
        json(201, { session, phase: kind.phase });
      });
      return;
    }
    if (sub === "/stream") {
      if (this.refuseStreams) return json(503, { detail: "down" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
      const set = this.streams.get(p.id) ?? new Set();
      set.add(res);
      this.streams.set(p.id, set);
      this.maxStreams.set(p.id, Math.max(this.maxStreams.get(p.id) ?? 0, set.size));
      res.on("close", () => set.delete(res));
      return;
    }
    if (sub === "/abort" && req.method === "POST") {
      // NEO: abort the session, busy = False, then status {busy: false, aborted: true} (persist=False).
      setTimeout(() => {
        p.busy = false;
        this.emitLive(p.id, { kind: "status", busy: false, aborted: true });
      }, 100);
      return json(200, { ok: true });
    }
    if ((sub === "/message" || sub === "/answer") && req.method === "POST") {
      // NEO's send(): the stall is cleared and a turn starts.
      Object.assign(p, { busy: true, needs_attention: false, attention_reason: null, awaiting_answer: false });
      return json(200, { ok: true });
    }
    return json(404, { detail: "not mocked" });
  }
}
