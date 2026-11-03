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
}

export class MockNeo {
  readonly projects = new Map<string, MockProject>();
  readonly calls: string[] = [];
  readonly maxStreams = new Map<string, number>();
  refuseStreams = false;
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
    const e = { ...ev, seq: ++this.seq };
    this.projects.get(id)!.history.push(e);
    return e;
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

  private detail(p: MockProject, history: number): Record<string, unknown> {
    return {
      project: { id: p.id, name: p.name, path: p.path, phase: p.phase, entry_type: "new", idea: "A todo CLI" },
      phase: p.phase, at_gate: p.at_gate, session_id: "ses", gate: p.gate, busy: p.busy, awaiting_answer: p.awaiting_answer,
      pending_request: p.pending_request, needs_attention: p.needs_attention, attention_reason: p.attention_reason,
      plan_progress: p.plan_progress, stages: [], path_missing: false,
      history: history > 0 ? p.history.slice(-history) : [], history_total: p.history.length, history_shown: Math.min(history, p.history.length),
    };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    this.calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/api/debug/status") return json(200, { opencode_reachable: true });
    if (url.pathname === "/api/projects" && req.method === "GET") {
      return json(200, { projects: [...this.projects.values()].map((p) => ({ id: p.id, name: p.name, path: p.path, phase: p.phase, entry_type: "new" })) });
    }
    const m = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const p = m ? this.projects.get(m[1]) : undefined;
    if (!m || !p) return json(404, { detail: "not found" });
    const sub = m[2] ?? "";
    if (sub === "" && req.method === "GET") return json(200, this.detail(p, Number(url.searchParams.get("history") ?? 0)));
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
