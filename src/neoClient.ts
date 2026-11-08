/**
 * Typed wrappers over the existing NEO-AG HTTP API. Nothing here decides anything: every phase,
 * gate and check is NEO's. This file only knows routes and shapes.
 *
 * Runs in the extension host, never the webview — NEO has no CORS or auth layer for browser
 * origins, so a webview fetch would be refused (and should be).
 */

/** NEO could not be reached at all: nothing was delivered. */
export class NeoUnreachable extends Error {
  constructor(public readonly baseUrl: string, cause?: unknown) {
    super(`NEO not reachable at ${hostOf(baseUrl)}`);
    this.name = "NeoUnreachable";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** NEO answered, and refused. `detail` is FastAPI's `detail`: a string or an object. */
export class NeoHttpError extends Error {
  constructor(public readonly status: number, public readonly detail: unknown) {
    super(describeDetail(status, detail));
    this.name = "NeoHttpError";
  }
}

export interface Project {
  id: string;
  name: string;
  path: string;
  phase: string;
  entry_type: string;
  idea?: string | null;
  interaction?: string;
  path_missing?: boolean;
  archived?: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  conclusive?: boolean;
  advisory?: boolean;
}

export interface Gate {
  phase?: string;
  title?: string;
  artifact_path?: string;
  artifact?: string;
  artifact_missing?: boolean;
  checks?: Check[];
  checks_pending?: boolean;
}

export interface Stage {
  phase: string;
  label: string;
  kind: string;
  state: "done" | "active" | "pending";
}

/** A normalized stream event. `seq` is the DB row id; live and replayed copies share it. */
export interface NeoEvent {
  kind: string;
  seq?: number;
  [field: string]: unknown;
}

/**
 * A NEO work session: one thing someone asked for (the build, a change afterwards). Not the agent
 * runtime's session (the `ses_…` id in `Project.session_id`), which means nothing to the user.
 */
export interface NeoSession {
  id: string;
  project_id?: string;
  kind: string;
  title: string;
  request?: string | null;
  /** Seconds since the epoch, NEO's clock. */
  created_at: number;
  /** Set only when another session started after it. */
  ended_at: number | null;
  events?: number;
  messages?: number;
  /** The seq of the session's first and last stored event; null while it has none. */
  first_event?: number | null;
  last_event?: number | null;
}

export interface SessionKind {
  label?: string;
  description?: string;
  phase?: string;
}

/** One row of NEO's gate audit trail. `created_at` is NEO's clock. */
export interface GateEvent {
  id?: string;
  phase: string;
  action: string;
  manual?: number;
  feedback?: string | null;
  created_at: number;
}

export interface ProjectDetail {
  project: Project;
  phase: string;
  at_gate: boolean;
  /** The NEO work session this read is about: the newest one unless `session` was asked for. */
  session_id: string | null;
  /** Every session of the project, oldest first. Absent from NEO versions without sessions. */
  sessions?: NeoSession[];
  gate_events?: GateEvent[];
  /** Where each phase began in the session read: phase -> its first event's seq ("done" when it finished). */
  phase_marks?: Record<string, number>;
  gate: Gate | null;
  busy: boolean;
  awaiting_answer: boolean;
  pending_request: string | null;
  needs_attention: boolean;
  attention_reason: string | null;
  plan_progress: { done: number; total: number } | null;
  stages: Stage[];
  path_missing: boolean;
  history: NeoEvent[];
  history_total: number;
  history_shown: number;
}

export interface DebugStatus {
  opencode_reachable: boolean;
  opencode_url?: string;
}

export interface CreateProjectBody {
  name: string;
  entry_type: "new";
  idea: string;
  interaction: "max" | "high" | "normal" | "low";
}

export class NeoClient {
  constructor(public readonly baseUrl: string) {}

  status(): Promise<DebugStatus> {
    return this.request("GET", "/api/debug/status");
  }

  async listProjects(): Promise<Project[]> {
    const data = await this.request<{ projects: Project[] }>("GET", "/api/projects");
    return data.projects ?? [];
  }

  /** `session` reads an earlier session's history; it never changes which session is active. */
  project(id: string, history: number, session?: string): Promise<ProjectDetail> {
    const scope = session ? `&session=${enc(session)}` : "";
    return this.request("GET", `/api/projects/${enc(id)}?history=${history}${scope}`);
  }

  async sessions(id: string): Promise<{ sessions: NeoSession[]; kinds: Record<string, SessionKind> }> {
    const data = await this.request<{ sessions?: NeoSession[]; kinds?: Record<string, SessionKind> }>(
      "GET",
      `/api/projects/${enc(id)}/sessions`,
    );
    return { sessions: data.sessions ?? [], kinds: data.kinds ?? {} };
  }

  /**
   * Another piece of work on the same project (NEO's POST /sessions): the current session ends, a
   * new one starts at its kind's first phase, and the earlier sessions keep their own history.
   */
  startSession(id: string, body: { kind: string; request: string; title?: string }): Promise<{ session: NeoSession; phase: string }> {
    return this.request("POST", `/api/projects/${enc(id)}/sessions`, body);
  }

  createProject(body: CreateProjectBody): Promise<Project> {
    return this.request("POST", "/api/projects", body);
  }

  start(id: string, text?: string): Promise<{ phase: string }> {
    return this.request("POST", `/api/projects/${enc(id)}/start`, text ? { text } : {});
  }

  message(id: string, text: string): Promise<{ ok: boolean }> {
    return this.request("POST", `/api/projects/${enc(id)}/message`, { text });
  }

  answer(id: string, body: { text: string } | { answers: string[] }): Promise<{ answered: boolean }> {
    return this.request("POST", `/api/projects/${enc(id)}/answer`, body);
  }

  approve(id: string, overrule?: { reason: string }): Promise<{ phase: string }> {
    return this.request(
      "POST",
      `/api/projects/${enc(id)}/gate/approve`,
      overrule ? { confirm: true, reason: overrule.reason } : {},
    );
  }

  reject(id: string, feedback: string): Promise<{ phase: string }> {
    return this.request("POST", `/api/projects/${enc(id)}/gate/reject`, { feedback });
  }

  abort(id: string): Promise<{ ok: boolean }> {
    return this.request("POST", `/api/projects/${enc(id)}/abort`);
  }

  streamUrl(id: string): string {
    return `${this.baseUrl}/api/projects/${enc(id)}/stream`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A wedged server must not freeze the panel. Gate approval re-runs the checks, which can
        // take minutes at a merge gate, so writes get far longer than reads.
        signal: AbortSignal.timeout(method === "GET" ? 30_000 : 15 * 60_000),
      });
    } catch (err) {
      throw new NeoUnreachable(this.baseUrl, err);
    }
    const text = await res.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { detail: text };
      }
    }
    if (!res.ok) {
      const detail = (data as { detail?: unknown }).detail ?? res.statusText;
      throw new NeoHttpError(res.status, detail);
    }
    return data as T;
  }
}

/** "127.0.0.1:8720" out of "http://127.0.0.1:8720/". */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

function describeDetail(status: number, detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const error = (detail as { error?: unknown }).error;
    if (typeof error === "string") return error;
    // FastAPI validation errors: [{loc, msg, ...}]
    if (Array.isArray(detail)) {
      return detail.map((d) => (d && typeof d === "object" && "msg" in d ? String(d.msg) : String(d))).join("; ");
    }
  }
  return `NEO answered HTTP ${status}`;
}
