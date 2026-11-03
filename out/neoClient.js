"use strict";
/**
 * Typed wrappers over the existing NEO-AG HTTP API. Nothing here decides anything: every phase,
 * gate and check is NEO's. This file only knows routes and shapes.
 *
 * Runs in the extension host, never the webview — NEO has no CORS or auth layer for browser
 * origins, so a webview fetch would be refused (and should be).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NeoClient = exports.NeoHttpError = exports.NeoUnreachable = void 0;
exports.hostOf = hostOf;
/** NEO could not be reached at all: nothing was delivered. */
class NeoUnreachable extends Error {
    baseUrl;
    constructor(baseUrl, cause) {
        super(`NEO not reachable at ${hostOf(baseUrl)}`);
        this.baseUrl = baseUrl;
        this.name = "NeoUnreachable";
        if (cause !== undefined)
            this.cause = cause;
    }
}
exports.NeoUnreachable = NeoUnreachable;
/** NEO answered, and refused. `detail` is FastAPI's `detail`: a string or an object. */
class NeoHttpError extends Error {
    status;
    detail;
    constructor(status, detail) {
        super(describeDetail(status, detail));
        this.status = status;
        this.detail = detail;
        this.name = "NeoHttpError";
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
    project(id, history) {
        return this.request("GET", `/api/projects/${enc(id)}?history=${history}`);
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
            throw new NeoUnreachable(this.baseUrl, err);
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
            throw new NeoHttpError(res.status, detail);
        }
        return data;
    }
}
exports.NeoClient = NeoClient;
/** "127.0.0.1:8720" out of "http://127.0.0.1:8720/". */
function hostOf(baseUrl) {
    try {
        return new URL(baseUrl).host;
    }
    catch {
        return baseUrl;
    }
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