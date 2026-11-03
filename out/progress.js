"use strict";
/**
 * Live progress: what NEO is doing right now, derived from what NEO already reports.
 *
 * Nothing here decides anything about the pipeline. It reads the state and the event stream the
 * extension already receives and turns them into one small, user-facing picture:
 *
 *   - which plan task is being worked on  (plan document + `plan_progress`)
 *   - how much of the plan is done        (`plan_progress`)
 *   - what NEO is doing this second       (the `tool` / `text` events)
 *   - whether it is working, stopping, waiting, stalled or reconnecting
 *
 * Kept in its own file so the sidebar's shared code stays almost untouched: `chatViewProvider`
 * feeds it events and state, `media/progress.js` draws what `buildLive()` returns.
 */
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
exports.ActionTracker = exports.PlanTracker = exports.STOP_HINT = void 0;
exports.parsePlanTasks = parsePlanTasks;
exports.planTitles = planTitles;
exports.toolPhrase = toolPhrase;
exports.phaseAction = phaseAction;
exports.fileLabel = fileLabel;
exports.noticeOf = noticeOf;
exports.liveNotice = liveNotice;
exports.buildLive = buildLive;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
exports.STOP_HINT = "Stop what NEO is doing now. The running turn is aborted - nothing already written is undone " +
    "and the project stays in this phase. Afterwards you can send a new message or answer.";
// "- [ ] 3. Implement CRUD routes", "* [x] Scaffold", "1. [ ] ..."
const TICK = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*\S)\s*$/;
/** The checklist items of a plan document, in order, with their indentation. */
function parsePlanTasks(doc) {
    const tasks = [];
    let fenced = false;
    for (const raw of String(doc || "").split(/\r\n?|\n/)) {
        if (/^\s*```/.test(raw)) {
            fenced = !fenced;
            continue;
        }
        if (fenced)
            continue;
        const m = TICK.exec(raw);
        if (!m)
            continue;
        tasks.push({ indent: m[1].replace(/\t/g, "  ").length, done: m[2] !== " ", title: cleanTitle(m[3]) });
    }
    return tasks;
}
/**
 * The level of the list NEO is counting.
 *
 * A plan can nest sub-steps under a task; `plan_progress.total` counts one of those levels. The
 * level whose item count matches is the right one - and when nothing matches (an edited plan, a
 * total we do not have) the outermost level is the best guess.
 */
function planTitles(tasks, total) {
    if (!tasks.length)
        return [];
    const levels = new Map();
    for (const t of tasks) {
        const at = levels.get(t.indent);
        if (at)
            at.push(t);
        else
            levels.set(t.indent, [t]);
    }
    if (total) {
        if (tasks.length === total)
            return tasks.map((t) => t.title);
        for (const group of levels.values())
            if (group.length === total)
                return group.map((t) => t.title);
    }
    const shallowest = Math.min(...levels.keys());
    return (levels.get(shallowest) ?? tasks).map((t) => t.title);
}
function cleanTitle(raw) {
    let t = String(raw)
        .replace(/`([^`]*)`/g, "$1")
        .replace(/\*\*([^*]*)\*\*/g, "$1")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/^\s*(?:task|step)?\s*\d+\s*[.):\-]\s*/i, "")
        .replace(/\s+/g, " ")
        .trim();
    if (t.length > 90)
        t = `${t.slice(0, 89).trimEnd()}…`;
    return t;
}
/** Whether a gate's document is the plan: the phase says so, or its checklist is the one counted. */
function looksLikePlan(phase, artifactPath, items, total) {
    const p = String(phase || "").toLowerCase();
    if (/^plan(-|$)/.test(p))
        return true;
    if (/plan/i.test(String(artifactPath || "")))
        return true;
    return Boolean(total && items === total && items > 1);
}
/**
 * Remembers the plan of the selected project, so "Task 3 of 8 - Implement CRUD routes" survives
 * the plan gate scrolling out of the history window and the webview reloading.
 *
 * Three sources, in order: the open gate's document, a `gate` event in the history, and - when the
 * window has been reloaded mid-execute - the plan file itself, read through the VS Code file API
 * (no shell, no separator assumptions).
 */
class PlanTracker {
    store;
    onChange;
    projectId;
    projectPath;
    memory = { titles: [] };
    reading = false;
    readTried = new Set();
    constructor(store, onChange) {
        this.store = store;
        this.onChange = onChange;
    }
    /** Select a project: load whatever was remembered about its plan last time. */
    start(projectId, projectPath) {
        this.projectId = projectId;
        this.projectPath = projectPath;
        this.reading = false;
        this.readTried.clear();
        this.memory = this.store?.get(this.key(projectId)) ?? { titles: [] };
    }
    stop() {
        this.projectId = undefined;
        this.projectPath = undefined;
        this.memory = { titles: [] };
        this.readTried.clear();
    }
    /** A gate - live event or open-gate state. Only the plan's document is kept. */
    noteGate(phase, artifactPath, artifact, total) {
        if (typeof artifact !== "string" || !artifact.trim())
            return;
        const tasks = parsePlanTasks(artifact);
        if (!tasks.length)
            return;
        if (!looksLikePlan(phase, artifactPath, tasks.length, total))
            return;
        this.remember({ artifactPath: artifactPath || this.memory.artifactPath, titles: planTitles(tasks, total) });
    }
    /** The plan as NEO's own file: ticks included, so a re-read also re-counts. */
    noteDoc(doc, total) {
        const tasks = parsePlanTasks(doc);
        if (!tasks.length)
            return;
        this.remember({ artifactPath: this.memory.artifactPath, titles: planTitles(tasks, total) });
    }
    remember(next) {
        const same = next.artifactPath === this.memory.artifactPath &&
            next.titles.length === this.memory.titles.length &&
            next.titles.every((t, i) => t === this.memory.titles[i]);
        this.memory = next;
        if (this.projectId)
            void this.store?.update(this.key(this.projectId), next);
        if (!same)
            this.onChange();
    }
    /** "Task 3 of 8 - Implement CRUD routes": the index is NEO's count, the title is the plan's. */
    current(progress) {
        if (!progress || !progress.total)
            return null;
        const total = progress.total;
        const done = Math.max(0, Math.min(progress.done, total));
        this.ensureTitles(total);
        const titles = this.memory.titles.length === total ? this.memory.titles : [];
        if (done >= total)
            return { index: total, total, title: titles[total - 1] };
        return { index: done + 1, total, title: titles[done] };
    }
    /**
     * Titles missing, or from a plan with a different number of steps: read the plan file once.
     * Failures are remembered too - a missing file must not be re-read every ten seconds.
     */
    ensureTitles(total) {
        if (this.memory.titles.length === total || this.reading)
            return;
        const file = this.planUri();
        if (!file)
            return;
        const key = `${file.toString()}#${total}`;
        if (this.readTried.has(key))
            return;
        this.readTried.add(key);
        this.reading = true;
        void (async () => {
            try {
                const bytes = await vscode.workspace.fs.readFile(file);
                this.noteDoc(Buffer.from(bytes).toString("utf8"), total);
            }
            catch {
                // No plan file where it was last seen (a worktree, a moved project): numbers only.
            }
            finally {
                this.reading = false;
            }
        })();
    }
    /** The remembered plan path, as a URI. Relative paths hang off the project folder. */
    planUri() {
        const rel = this.memory.artifactPath;
        if (!rel || !this.projectPath)
            return undefined;
        if (path.isAbsolute(rel))
            return vscode.Uri.file(rel);
        const parts = rel.split(/[\\/]+/).filter((p) => p && p !== ".");
        if (!parts.length || parts.includes(".."))
            return undefined;
        return vscode.Uri.joinPath(vscode.Uri.file(this.projectPath), ...parts);
    }
    key(projectId) {
        return `neo.plan.${projectId}`;
    }
}
exports.PlanTracker = PlanTracker;
// --- what NEO is doing right now --------------------------------------------------------------
// Tool rows that say nothing a user wants to read. They still reach the transcript; they just do
// not become "what NEO is doing".
const QUIET_TOOLS = new Set(["todoread", "todowrite", "think", "thinking", "nothing"]);
// Once a tool has named the action, prose does not take it back for this long: a turn interleaves
// text and tool calls constantly, and the line must not flicker.
const TOOL_HOLD_MS = 4_000;
/** The latest meaningful action, from the events the sidebar already receives. */
class ActionTracker {
    text = null;
    at = 0;
    fromTool = false;
    reset() {
        this.text = null;
        this.at = 0;
        this.fromTool = false;
    }
    current() {
        return this.text;
    }
    /** Feed one event. Phase is used only for the wording of a plain thinking/writing stretch. */
    note(ev, phase) {
        switch (ev.kind) {
            case "tool": {
                const phrase = toolPhrase(ev);
                if (!phrase)
                    return;
                this.text = phrase;
                this.at = Date.now();
                this.fromTool = true;
                return;
            }
            case "text": {
                if (this.fromTool && Date.now() - this.at < TOOL_HOLD_MS)
                    return;
                this.text = phaseAction(phase);
                this.at = Date.now();
                this.fromTool = false;
                return;
            }
            // Anything that means the turn is over, or that the user is now the one being waited on.
            case "idle":
            case "gate":
            case "question":
            case "phase":
                this.reset();
                return;
            case "status":
                if (ev.busy === false)
                    this.reset();
                return;
            case "notice":
                if (ev.stalled || ev.timeout || ev.runaway)
                    this.reset();
                return;
        }
    }
}
exports.ActionTracker = ActionTracker;
/** "Editing main.py" out of a `tool` event - a verb and a name, never the arguments. */
function toolPhrase(ev) {
    const name = String(ev.tool ?? "").toLowerCase().replace(/^.*__/, "").replace(/[^a-z0-9]/g, "");
    if (!name || QUIET_TOOLS.has(name))
        return null;
    const title = typeof ev.title === "string" ? ev.title.trim() : "";
    const file = fileLabel(title);
    if (/^(read|view|cat|open|fileread)/.test(name))
        return file ? `Reading ${file}` : "Reading a file";
    if (/^(multiedit|edit|patch|applypatch|strreplace|update)/.test(name))
        return file ? `Editing ${file}` : "Editing a file";
    if (/^(write|create|filewrite|notebookedit)/.test(name))
        return file ? `Writing ${file}` : "Writing a file";
    if (/^(grep|search|ripgrep|rg|glob|find|ls|list|tree)/.test(name))
        return "Searching the project";
    if (/^(task|agent|subagent|dispatch|delegate)/.test(name))
        return "Running a sub-agent";
    if (/^(webfetch|fetch|http|websearch|browse)/.test(name))
        return "Reading documentation";
    if (/^(bash|shell|sh|exec|run|terminal|cmd|powershell|process)/.test(name))
        return commandPhrase(title);
    // An unknown tool still reads sensibly: "Running migrate".
    return `Running ${spaced(name)}`;
}
/** What a shell command is for, from the command itself. Never the command line. */
function commandPhrase(command) {
    const c = command.toLowerCase();
    if (/\b(pytest|jest|vitest|mocha|unittest|go test|cargo test|dotnet test|npm (run )?test|yarn test|pnpm test|rspec|phpunit)\b/.test(c)) {
        return "Running tests";
    }
    if (/\b(eslint|ruff|flake8|pylint|black|prettier|gofmt|clippy|mypy)\b/.test(c))
        return "Checking code style";
    if (/\b(tsc|webpack|make|msbuild|cargo build|go build|dotnet build)\b/.test(c) || /\b(npm|yarn|pnpm) run build\b/.test(c)) {
        return "Building the project";
    }
    if (/\b(npm (ci|install|i)|yarn add|pnpm (add|install)|pip install|poetry install|cargo add|go get|dotnet restore)\b/.test(c)) {
        return "Installing dependencies";
    }
    if (/\bgit\b/.test(c))
        return "Running git";
    if (/\b(alembic|migrate|migration)\b/.test(c))
        return "Running migrations";
    if (/\b(uvicorn|flask run|npm start|serve|docker)\b/.test(c))
        return "Starting the app";
    return "Running a command";
}
/**
 * A stretch of prose with no tool behind it, named by the phase it happens in - this is the
 * difference between "working" and "Reviewing the implementation".
 */
function phaseAction(phase) {
    const p = String(phase || "").toLowerCase();
    if (p.startsWith("analysis"))
        return "Analysing the project";
    if (p.startsWith("brainstorm"))
        return "Exploring approaches";
    if (p.startsWith("design"))
        return "Writing the design";
    if (p.startsWith("plan"))
        return "Writing the plan";
    if (p.startsWith("execute"))
        return "Working on the task";
    if (p.startsWith("review"))
        return "Reviewing the implementation";
    if (p.startsWith("merge"))
        return "Preparing the merge";
    return "Thinking";
}
/**
 * The name in a tool's title, when the title is a path. Separator-agnostic on purpose: NEO may be
 * on Linux while the sidebar is on Windows, so neither `path.win32` nor `path.posix` is right.
 */
function fileLabel(title) {
    if (!title)
        return null;
    const first = title.split(/\s+/)[0];
    if (!/[\\/.]/.test(first) || /^https?:/i.test(first))
        return null;
    const name = first.split(/[\\/]+/).filter(Boolean).pop();
    if (!name || name.length > 40)
        return null;
    return name;
}
function spaced(name) {
    return name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}
// --- notices ------------------------------------------------------------------------------------
/** How long an informational notice stays on the live line before it is only history. */
const INFO_NOTICE_MS = 25_000;
/**
 * The few notices that describe the *current* state rather than something that happened. The
 * transcript keeps every notice; this line repeats only the one the user still has to act on.
 */
function noticeOf(ev) {
    const held = (tone, text, sticky) => ({
        tone,
        text,
        at: Date.now(),
        sticky,
    });
    if (ev.stalled)
        return held("warn", `NEO is stalled in ${String(ev.stalled)} - send guidance to continue`, true);
    if (ev.timeout)
        return held("warn", `No activity for ${String(ev.timeout)}s - the turn was stopped`, true);
    if (ev.runaway)
        return held("warn", "Runaway output - the turn was stopped", true);
    if (ev.repair_stuck) {
        return held("warn", `Automatic repair stopped on ${String(ev.repair_stuck)} - the gate is open for you`, true);
    }
    if (ev.held)
        return held("warn", `${String(ev.held)} is held for you: ${String(ev.failed ?? "a check did not pass")}`, true);
    if (ev.incomplete) {
        return ev.exhausted
            ? held("warn", `Execution stopped with ${String(ev.count)} plan step(s) left - waiting for you`, true)
            : held("info", `${String(ev.count)} plan step(s) left - NEO is continuing (attempt ${String(ev.attempt)}/${String(ev.limit)})`, false);
    }
    if (ev.resumed)
        return held("info", `A turn in ${String(ev.resumed)} was interrupted by a restart - NEO resumed it`, false);
    return null; // everything else is history, not a live state
}
/** Drop a notice that has aged out, or that a newer state has answered. */
function liveNotice(notice, busy) {
    if (!notice)
        return null;
    if (!notice.sticky && Date.now() - notice.at > INFO_NOTICE_MS)
        return null;
    if (notice.sticky && busy)
        return null; // NEO is moving again: the stall is over
    return { tone: notice.tone, text: notice.text };
}
// --- the whole picture ---------------------------------------------------------------------------
/** How long "Stopped" stays on screen after an abort takes effect. */
const STOPPED_MS = 12_000;
function buildLive(s, task, action, note) {
    const connected = s.connection === "connected";
    const inProject = s.mode === "project";
    const phase = s.phase ?? "";
    // "Working" is NEO running a turn - not waiting on an answer, an approval, or on nothing.
    const working = connected && inProject && s.busy && !s.awaiting && !s.atGate;
    const canStop = working && !s.stopping && phase !== "done";
    const stopped = Boolean(s.stoppedAt && Date.now() - s.stoppedAt < STOPPED_MS && !s.busy);
    let activity;
    let label;
    let detail;
    if (!connected) {
        activity = "offline";
        label = s.connection === "connecting" ? "connecting" : "not connected";
        detail = "NEO is not reachable. Progress cannot be read until the connection is back.";
    }
    else if (!inProject) {
        activity = "loading";
        label = s.mode === "loading" ? "loading" : "";
        detail = "No NEO project selected in this window.";
    }
    else if (s.stopping) {
        activity = "stopping";
        label = "stopping";
        detail = "Stop was sent. NEO is ending the running turn; this takes a moment.";
    }
    else if (s.awaiting) {
        activity = "awaiting";
        label = "waiting for your answer";
        detail = "NEO asked a question and is waiting. Answer it above, or type your own answer below.";
    }
    else if (s.atGate) {
        activity = "gate";
        label = "waiting for your approval";
        detail = "NEO reached a gate. It will not continue until you approve or request changes.";
    }
    else if (working) {
        activity = "working";
        label = "working";
        detail = action ? `NEO is working: ${action.toLowerCase()}.` : "NEO is working on this project.";
    }
    else if (phase === "done") {
        activity = "done";
        label = "done";
        detail = "This project reached the end of the pipeline.";
    }
    else if (s.needsAttention && s.attentionReason) {
        activity = "attention";
        label = "waiting on you";
        detail = `NEO stopped and is waiting on you: ${s.attentionReason}`;
    }
    else if (stopped) {
        activity = "stopped";
        label = "stopped";
        detail = "The turn was stopped. Nothing already written was undone - send a message to continue.";
    }
    else {
        activity = "idle";
        label = "idle";
        detail = "NEO is not running anything. Send a message to continue.";
    }
    // One voice for the exceptional state: NEO's own reason wins over the remembered notice, so a
    // stall is never announced twice in the same place.
    const attention = inProject && connected && s.needsAttention && s.attentionReason && !s.awaiting && !s.atGate
        ? { tone: "warn", text: `Waiting on you: ${s.attentionReason}` }
        : null;
    const stoppedNote = stopped
        ? { tone: "info", text: "Turn stopped - nothing was undone. Send a message to continue." }
        : null;
    // A plan is worth showing once there is one to be part-way through. Before Execute the plan
    // gate card itself is on screen, so an untouched "0 of 8" there would only repeat it.
    const plan = s.planProgress;
    const showPlan = inProject &&
        connected &&
        Boolean(plan && plan.total > 0 && (/^(execute|review|merge|done)/.test(phase) || plan.done > 0));
    return {
        activity,
        label,
        detail,
        task: showPlan ? task : null,
        progress: showPlan ? plan : null,
        action: working ? action : null,
        note: attention ?? (inProject ? note ?? stoppedNote : null),
        stream: { state: s.stream, retryAt: s.streamRetryAt, catchingUp: s.catchingUp },
        canStop,
        stopHint: exports.STOP_HINT,
    };
}
//# sourceMappingURL=progress.js.map