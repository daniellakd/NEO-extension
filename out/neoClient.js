"use strict";
/**
 * Typed wrappers over the existing NEO-AG HTTP API. Nothing here decides anything: every phase,
 * gate and check is NEO's. This file only knows routes and shapes.
 *
 * Runs in the extension host, never the webview — NEO has no CORS or auth layer for browser
 * origins, so a webview fetch would be refused (and should be).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SERVER_URL = exports.NeoClient = exports.NeoHttpError = exports.NeoUnreachable = void 0;
exports.hostOf = hostOf;
// Network failures that happen before a request can have been sent: nothing reached NEO.
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "ERR_INVALID_URL"]);
/**
 * NEO answered nothing. For a write this does not always mean nothing was delivered: a timeout or a
 * reset after the request went out may have left it done on NEO's side (`maybeDelivered`).
 */
class NeoUnreachable extends Error {
    baseUrl;
    method;
    route;
    /** The network cause, e.g. ECONNREFUSED, ENOTFOUND, TIMEOUT. */
    code;
    maybeDelivered;
    /** The server URL itself is the likely problem (malformed, or a host name that does not resolve). */
    config;
    constructor(baseUrl, cause, method = "GET", route = "") {
        super(`NEO not reachable at ${hostOf(baseUrl)}`);
        this.baseUrl = baseUrl;
        this.method = method;
        this.route = route;
        this.name = "NeoUnreachable";
        if (cause !== undefined)
            this.cause = cause;
        this.code = networkCode(cause);
        this.maybeDelivered = method !== "GET" && !NOT_SENT.has(this.code ?? "");
        this.config = this.code === "ERR_INVALID_URL" || this.code === "ENOTFOUND" || !validUrl(baseUrl);
    }
    /** For "Show details": what was asked, of which server, and why it failed. */
    technical() {
        const lines = [`${this.method} ${this.baseUrl}${this.route}`, `No response from NEO${this.code ? ` (${this.code})` : ""}.`];
        const why = causeText(this.cause);
        if (why)
            lines.push(why);
        return lines.join("\n");
    }
}
exports.NeoUnreachable = NeoUnreachable;
/** NEO answered, and refused. `detail` is FastAPI's `detail`: a string or an object. */
class NeoHttpError extends Error {
    status;
    detail;
    method;
    route;
    constructor(status, detail, method = "", route = "") {
        super(describeDetail(status, detail));
        this.status = status;
        this.detail = detail;
        this.method = method;
        this.route = route;
        this.name = "NeoHttpError";
    }
    /** For "Show details": the status, the route and NEO's whole response. */
    technical() {
        const head = `HTTP ${this.status}${this.method ? ` · ${this.method} ${this.route}` : ""}`;
        const body = typeof this.detail === "string" ? this.detail : JSON.stringify(this.detail, null, 2);
        return body ? `${head}\n${body}` : head;
    }
}
exports.NeoHttpError = NeoHttpError;
class NeoClient {
    baseUrl;
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }
    status() {
        return this.request("GET", "/api/debug/status");
    }
    async listProjects() {
        const data = await this.request("GET", "/api/projects");
        return data.projects ?? [];
    }
    /** `session` reads an earlier session's history; it never changes which session is active. */
    project(id, history, session) {
        const scope = session ? `&session=${enc(session)}` : "";
        return this.request("GET", `/api/projects/${enc(id)}?history=${history}${scope}`);
    }
    async sessions(id) {
        const data = await this.request("GET", `/api/projects/${enc(id)}/sessions`);
        return { sessions: data.sessions ?? [], kinds: data.kinds ?? {} };
    }
    /**
     * Another piece of work on the same project (NEO's POST /sessions): the current session ends, a
     * new one starts at its kind's first phase, and the earlier sessions keep their own history.
     */
    startSession(id, body) {
        return this.request("POST", `/api/projects/${enc(id)}/sessions`, body);
    }
    createProject(body) {
        return this.request("POST", "/api/projects", body);
    }
    start(id, text) {
        return this.request("POST", `/api/projects/${enc(id)}/start`, text ? { text } : {});
    }
    message(id, text) {
        return this.request("POST", `/api/projects/${enc(id)}/message`, { text });
    }
    answer(id, body) {
        return this.request("POST", `/api/projects/${enc(id)}/answer`, body);
    }
    approve(id, overrule) {
        return this.request("POST", `/api/projects/${enc(id)}/gate/approve`, overrule ? { confirm: true, reason: overrule.reason } : {});
    }
    reject(id, feedback) {
        return this.request("POST", `/api/projects/${enc(id)}/gate/reject`, { feedback });
    }
    abort(id) {
        return this.request("POST", `/api/projects/${enc(id)}/abort`);
    }
    streamUrl(id) {
        return `${this.baseUrl}/api/projects/${enc(id)}/stream`;
    }
    async request(method, path, body) {
        let res;
        try {
            res = await fetch(this.baseUrl + path, {
                method,
                headers: body === undefined ? undefined : { "Content-Type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
                // A wedged server must not freeze the panel. Gate approval re-runs the checks, which can
                // take minutes at a merge gate, so writes get far longer than reads.
                signal: AbortSignal.timeout(method === "GET" ? 30_000 : 15 * 60_000),
            });
        }
        catch (err) {
            throw new NeoUnreachable(this.baseUrl, err, method, path);
        }
        const text = await res.text();
        let data = {};
        if (text) {
            try {
                data = JSON.parse(text);
            }
            catch {
                data = { detail: text };
            }
        }
        if (!res.ok) {
            const detail = data.detail ?? res.statusText;
            throw new NeoHttpError(res.status, detail, method, path);
        }
        return data;
    }
}
exports.NeoClient = NeoClient;
/**
 * Where NEO serves by default: NEO-AG's own default port (config/neoag.toml, `[orchestrator] port`),
 * which is 8000. `neo.serverUrl`'s default in package.json must be this same string.
 */
exports.DEFAULT_SERVER_URL = "http://127.0.0.1:8000";
/** "127.0.0.1:8000" out of "http://127.0.0.1:8000/". */
function hostOf(baseUrl) {
    try {
        return new URL(baseUrl).host;
    }
    catch {
        return baseUrl;
    }
}
function validUrl(baseUrl) {
    try {
        return /^https?:$/.test(new URL(baseUrl).protocol);
    }
    catch {
        return false;
    }
}
/** The innermost error code of a failed fetch: Node wraps the socket error as `cause`. */
function networkCode(err) {
    for (let e = err, depth = 0; e && typeof e === "object" && depth < 5; e = e.cause, depth++) {
        const { code, name } = e;
        if (name === "TimeoutError")
            return "TIMEOUT";
        if (typeof code === "string" && code)
            return code;
    }
    return undefined;
}
function causeText(err) {
    const parts = [];
    for (let e = err, depth = 0; e && typeof e === "object" && depth < 5; e = e.cause, depth++) {
        const message = e.message;
        if (typeof message === "string" && message && !parts.includes(message))
            parts.push(message);
    }
    return parts.join(" ← ");
}
function enc(id) {
    return encodeURIComponent(id);
}
function describeDetail(status, detail) {
    if (typeof detail === "string")
        return detail;
    if (detail && typeof detail === "object") {
        const error = detail.error;
        if (typeof error === "string")
            return error;
        // FastAPI validation errors: [{loc, msg, ...}]
        if (Array.isArray(detail)) {
            return detail.map((d) => (d && typeof d === "object" && "msg" in d ? String(d.msg) : String(d))).join("; ");
        }
    }
    return `NEO answered HTTP ${status}`;
}
//# sourceMappingURL=neoClient.js.map