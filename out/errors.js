"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPEN_SETTINGS = void 0;
exports.describeError = describeError;
exports.plainText = plainText;
exports.logError = logError;
exports.showLog = showLog;
exports.notifyError = notifyError;
exports.openSettings = openSettings;
const vscode = __importStar(require("vscode"));
const neoClient_1 = require("./neoClient");
const SUMMARY = {
    connect: ["Could not connect to NEO."],
    loadProject: ["Could not load the NEO project."],
    refresh: ["Could not reload the NEO project."],
    listProjects: ["Could not load the NEO projects."],
    createProject: ["Could not create the NEO project.", "NEO did not confirm the new project."],
    startProject: ["The project was created, but NEO could not start it.", "The project was created; NEO did not confirm that it started."],
    send: ["Your message was not sent.", "NEO did not confirm your message."],
    answer: ["Your answer was not sent.", "NEO did not confirm your answer."],
    approve: ["Could not approve the gate.", "NEO did not confirm the approval."],
    reject: ["Could not send the change request.", "NEO did not confirm the change request."],
    abort: ["Could not stop the running turn.", "NEO did not confirm the stop."],
    startSession: ["Could not start a new session.", "NEO did not confirm the new session."],
    loadSessions: ["Could not load the sessions."],
};
/** NEO's known refusals, by status and message, in plain words. Only messages NEO really sends. */
const KNOWN = [
    { status: 409, match: /a project named .* already exists/i, hint: "A NEO project with this name already exists. Open it from Projects, or use a different name." },
    { status: 422, match: /already exists and is not empty/i, hint: "NEO's folder for this project already exists and is not empty. NEO creates a new project only in an empty folder." },
    { status: 422, match: /must contain at least one alphanumeric/i, hint: "The project name needs at least one letter or digit." },
    { status: 422, match: /^git .* failed/i, hint: "NEO could not set up git in the project folder. Check that git is installed and the folder is writable." },
    { status: 422, match: /is not a directory|is not a git repository|is not a work tree/i, hint: "NEO cannot use this folder as a project folder." },
    { status: 409, match: /project already started/i, hint: "The project has already started; reload to see where it is." },
    { status: 422, match: /idea description is required/i, hint: "Describe what you want built to start the project." },
    { status: 409, match: /agent is still working/i, hint: "NEO is still working on the current session. Wait for it to finish, or press Stop, then start the new session." },
    { status: 422, match: /unknown session kind/i, hint: "NEO does not offer that kind of session. Refresh and choose again." },
    { status: 404, match: /no such session/i, hint: "NEO has no such session in this project." },
    { status: 404, match: /project not found/i, hint: "NEO no longer has this project. It may have been deleted; choose another from Projects." },
    { status: 422, match: /an answer is required/i, hint: "Type an answer first." },
    { status: 502, match: /./, hint: "NEO is running, but its agent runtime is not reachable. Check the runtime NEO uses, then try again." },
    { status: "5xx", match: /./, hint: "NEO hit an internal error. Details below; the NEO server log has more." },
];
function describeError(err, action) {
    const [failed, unconfirmed] = SUMMARY[action];
    if (err instanceof neoClient_1.NeoUnreachable) {
        const maybeDelivered = err.maybeDelivered && Boolean(unconfirmed);
        let hint;
        if (err.config)
            hint = `The NEO server URL looks wrong (${err.baseUrl}). Check the neo.serverUrl setting.`;
        else if (maybeDelivered)
            hint = "The connection to NEO failed before it answered, so it may still have been received. Check the transcript before trying again.";
        else
            hint = `NEO is not reachable at ${err.baseUrl}. Make sure the NEO server is running, then retry.`;
        return {
            summary: maybeDelivered ? unconfirmed : failed,
            hint,
            detail: err.technical(),
            offline: true,
            config: err.config,
            maybeDelivered,
        };
    }
    if (err instanceof neoClient_1.NeoHttpError) {
        const raw = err.message;
        const known = KNOWN.find((k) => (k.status === "5xx" ? err.status >= 500 : k.status === err.status) && k.match.test(raw));
        // NEO's own refusals are written for people; an unrecognised one is shown as it is.
        const hint = known ? known.hint : err.status < 500 && raw && raw.length <= 200 ? sentence(raw) : undefined;
        return { summary: failed, hint, detail: err.technical(), offline: false, config: false, maybeDelivered: false };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { summary: failed, hint: message ? sentence(message) : undefined, offline: false, config: false, maybeDelivered: false };
}
/** Summary and hint as one line, for a native notification or a single-line message. */
function plainText(e) {
    return e.hint ? `${e.summary} ${e.hint}` : e.summary;
}
function sentence(s) {
    const t = s.trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
// --- technical details: the "NEO" output channel ----------------------------------------------
let channel;
/** Kept out of the sidebar: the full technical story of every error, for when it is needed. */
function logError(e) {
    try {
        channel ??= vscode.window.createOutputChannel("NEO");
        channel.appendLine(`[${new Date().toISOString()}] ${plainText(e)}`);
        if (e.detail)
            channel.appendLine(e.detail.replace(/^/gm, "    "));
    }
    catch {
        // No output channel (a test host): the detail is still in the sidebar.
    }
}
function showLog() {
    channel?.show(true);
}
exports.OPEN_SETTINGS = "Open NEO Settings";
const DETAILS = "Show Details";
const RETRY = "Retry";
/**
 * A native error notification: the summary up front, details in the output channel, Retry only
 * when the caller passes one (safe reads only), and the settings when configuration is the suspect.
 */
async function notifyError(e, retry) {
    logError(e);
    const actions = [...(retry ? [RETRY] : []), ...(e.offline ? [exports.OPEN_SETTINGS] : []), ...(e.detail ? [DETAILS] : [])];
    const picked = await vscode.window.showErrorMessage(`NEO: ${plainText(e)}`, ...actions);
    if (picked === RETRY)
        await retry?.();
    else if (picked === exports.OPEN_SETTINGS)
        await openSettings();
    else if (picked === DETAILS)
        showLog();
}
/** VS Code's own Settings editor, filtered to this extension's settings. */
function openSettings() {
    return vscode.commands.executeCommand("workbench.action.openSettings", "@ext:neoag.neo-vscode");
}
//# sourceMappingURL=errors.js.map