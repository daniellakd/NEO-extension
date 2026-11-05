"use strict";
/**
 * Design and Plan: what NEO designed, what it plans to build, and what the user approves at each
 * of those gates.
 *
 * Nothing here decides anything about the pipeline. It reads what NEO already reports and turns
 * it into one small picture the webview draws (media/plan.js):
 *
 *   - which documents the pipeline produces before Execute, and where   (NEO's stage list)
 *   - where each one stands: drafting, ready, changes requested, approved (NEO's gate events)
 *   - what is in it: a design's sections, a plan's tasks                 (the gate's document)
 *   - during Execute, which plan task is done, current or still to come   (Live Progress's own
 *     `live.task`, so the plan list and the progress line can never disagree)
 *
 * No gate is named here. The documents are the gate stages NEO lists with an artifact, up to and
 * including the plan's gate - found by the same rule Live Progress uses (src/progress.ts
 * `looksLikePlan`); a gate after the plan (the review) is not this module's. Opening a document is
 * a read-only Markdown preview of the real file: no copy, no temporary file.
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
exports.PlanArtifacts = void 0;
exports.documentGates = documentGates;
exports.outlineDocument = outlineDocument;
exports.outlinePlan = outlinePlan;
exports.statusOf = statusOf;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const changes_1 = require("./changes");
const planOutline_1 = require("./planOutline");
// --- reading the stage list -------------------------------------------------------------------
/** The rule Live Progress uses for "is this gate the plan's" (src/progress.ts looksLikePlan). */
function isPlanGate(stage) {
    return /^plan(-|$)/i.test(stage.phase) || /plan/i.test(String(stage.artifact || ""));
}
/**
 * The gate stages that produce a document before Execute: everything with an artifact up to and
 * including the plan's gate. Without a plan gate in this session (a quick change) there are none:
 * nothing is designed or planned.
 */
function documentGates(stages) {
    const gates = stages.filter((s) => s.kind === "gate" && s.artifact);
    const plan = gates.findIndex(isPlanGate);
    return plan < 0 ? [] : gates.slice(0, plan + 1);
}
// --- reading a document -------------------------------------------------------------------------
const H1 = /^#[ \t]+(.+?)[ \t#]*$/;
const H2 = /^##[ \t]+(.+?)[ \t#]*$/;
const FENCE = /^[ \t]*(?:```|~~~)/;
/** A design's title (its first `#` heading) and sections (its `##` headings), outside code. */
function outlineDocument(doc) {
    let title;
    const sections = [];
    let fenced = false;
    for (const line of String(doc || "").split(/\r\n?|\n/)) {
        if (FENCE.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced)
            continue;
        const h1 = H1.exec(line);
        if (h1 && !title) {
            title = (0, planOutline_1.cleanTitle)(h1[1]);
            continue;
        }
        const h2 = H2.exec(line);
        if (h2)
            sections.push((0, planOutline_1.cleanTitle)(h2[1]));
    }
    return { title, sections };
}
/**
 * A plan's tasks and step counts (src/planOutline.ts), or its checklist items when it has no
 * `Task N` headings. Every task starts as "todo"; Live Progress says otherwise during Execute.
 */
function outlinePlan(doc) {
    const { title } = outlineDocument(doc);
    const parsed = (0, planOutline_1.parsePlanOutline)(doc);
    if (parsed) {
        const steps = parsed.outline.tasks.map(() => 0);
        parsed.outline.stepTask.forEach((t) => {
            if (t >= 0 && t < steps.length)
                steps[t]++;
        });
        return {
            title,
            tasks: parsed.outline.tasks.map((t, i) => ({ title: t || `Task ${i + 1}`, steps: steps[i], state: "todo" })),
            steps: parsed.outline.stepTask.length,
        };
    }
    const items = (0, planOutline_1.parsePlanTasks)(doc);
    return { title, tasks: (0, planOutline_1.planTitles)(items, undefined).map((t) => ({ title: t, state: "todo" })), steps: items.length };
}
// --- status from the gate events ------------------------------------------------------------
const STATUS_OF = {
    detected: "ready",
    rechecked: "ready",
    rejected: "changes",
    approved: "approved",
    "auto-approved": "approved",
};
/**
 * Where a document stands, from this session's gate events - and, failing those (an older NEO, an
 * event outside the window), from the rail: an open gate is "ready", a passed one "approved", the
 * work stage before it running means "drafting".
 */
function statusOf(gate, before, events, atGate) {
    const history = [];
    // The latest "changes requested" feedback; an approval answers it.
    let feedback;
    for (const e of events) {
        if (e.phase !== gate.phase)
            continue;
        const status = STATUS_OF[e.action];
        if (!status)
            continue;
        if (status === "changes")
            feedback = e.feedback || undefined;
        if (status === "approved")
            feedback = undefined;
        if (history.length && history[history.length - 1].status === status)
            continue; // "ready, ready"
        history.push({ status, at: e.created_at });
    }
    const last = history[history.length - 1];
    // An open gate: the document is in front of the user now, whatever the events say - and the
    // changes requested last time are worth seeing next to the new version.
    if (atGate)
        return { status: "ready", at: last && last.status === "ready" ? last.at : undefined, history, feedback };
    if (last)
        return { status: last.status, at: last.at, history, feedback: last.status === "changes" ? feedback : undefined };
    if (gate.state === "done")
        return { status: "approved", history };
    if (gate.state === "active")
        return { status: "ready", history };
    if (before && before.state === "active")
        return { status: "drafting", history };
    return { history };
}
/**
 * Keeps what the last project read said about gates and sessions, builds the view on each state
 * post, and opens the documents.
 */
class PlanArtifacts {
    projectPath;
    events = [];
    since = 0;
    items = [];
    /** A project read: its gate events, limited to the session being shown. */
    noteDetail(detail) {
        this.projectPath = detail.project?.path;
        this.events = Array.isArray(detail.gate_events) ? detail.gate_events : [];
        const sessions = Array.isArray(detail.sessions) ? detail.sessions : [];
        const current = sessions.find((s) => s.id === detail.session_id);
        // A gate decided in an earlier session belongs to that session's documents, not this one's.
        this.since = current ? current.created_at - 1 : 0;
    }
    /** The project changed or went away. */
    reset() {
        this.projectPath = undefined;
        this.events = [];
        this.since = 0;
        this.items = [];
    }
    build(s) {
        if (s.mode !== "project")
            return { items: (this.items = []) };
        const stages = s.stages || [];
        const events = this.events.filter((e) => e.created_at >= this.since);
        const items = [];
        for (const gate of documentGates(stages)) {
            const atGate = Boolean(s.atGate && s.gate && s.gate.phase === gate.phase);
            const before = stages[stages.indexOf(gate) - 1];
            const st = statusOf(gate, before && before.kind !== "gate" ? before : undefined, events, atGate);
            if (!st.status)
                continue; // not produced yet: nothing to show
            const doc = atGate && s.gate?.artifact ? s.gate.artifact : latestText(events, gate.phase) ?? latestText(this.events, gate.phase);
            const item = {
                phase: gate.phase,
                label: gate.label,
                path: (atGate && s.gate?.artifact_path) || String(gate.artifact),
                kind: isPlanGate(gate) ? "plan" : "document",
                status: st.status,
                statusAt: st.at,
                history: st.history,
                feedback: st.feedback,
                atGate,
            };
            if (item.kind === "plan")
                Object.assign(item, planPart(doc, s.live?.task ?? null));
            else if (doc)
                Object.assign(item, outlineDocument(doc));
            items.push(item);
        }
        this.items = items;
        return { items };
    }
    /** Handles "plan.*" messages; true if it was one. */
    async onMessage(m) {
        if (m.type !== "plan.open")
            return m.type.startsWith("plan.");
        const item = this.items.find((i) => i.phase === m.phase);
        if (item)
            await this.open(item, m.as === "source" ? "source" : "preview");
        return true;
    }
    /**
     * The real document, read-only by default: VS Code's Markdown preview. During Execute the plan is
     * ticked in the worktree, so that copy comes first; a design is the project's own.
     */
    async open(item, as) {
        const uri = await this.locate(item);
        if (!uri) {
            void vscode.window.showInformationMessage(`NEO: ${item.label} (${item.path}) was not found in the project${item.kind === "plan" ? " or its worktree" : ""}.`);
            return;
        }
        if (as === "preview") {
            try {
                await vscode.commands.executeCommand("markdown.showPreview", uri);
                return;
            }
            catch {
                // No Markdown preview (the built-in extension disabled): fall back to the file itself.
            }
        }
        await vscode.window.showTextDocument(uri, { preview: true });
    }
    async locate(item) {
        const projectPath = this.projectPath;
        const parts = item.path.split(/[\\/]+/).filter((p) => p && p !== ".");
        if (!projectPath || !parts.length || parts.includes("..") || path.isAbsolute(item.path))
            return undefined;
        const roots = [projectPath];
        try {
            const { work } = await (0, changes_1.worktrees)(projectPath);
            if (work)
                roots[item.kind === "plan" ? "unshift" : "push"](work.path);
        }
        catch {
            // Not a git repository, or git missing: the project folder alone.
        }
        for (const root of roots) {
            const uri = vscode.Uri.joinPath(vscode.Uri.file(root), ...parts);
            try {
                await vscode.workspace.fs.stat(uri);
                return uri;
            }
            catch {
                // Not in this tree.
            }
        }
        return undefined;
    }
}
exports.PlanArtifacts = PlanArtifacts;
/** The newest document text NEO stored for a gate. */
function latestText(events, phase) {
    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.phase === phase && typeof e.artifact_text === "string" && e.artifact_text.trim())
            return e.artifact_text;
    }
    return undefined;
}
/**
 * The plan's tasks. During Execute their states are Live Progress's (`live.task.tasks`), the same
 * list its "Task 3 of 8" line comes from; the document only adds the step counts.
 */
function planPart(doc, task) {
    const fromDoc = doc ? outlinePlan(doc) : undefined;
    const live = task && task.unit === "task" && task.tasks && task.tasks.length ? task.tasks : undefined;
    let tasks = fromDoc?.tasks;
    if (live) {
        const sameShape = tasks && tasks.length === live.length;
        tasks = live.map((t, i) => ({
            title: t.title || (sameShape ? tasks[i].title : `Task ${i + 1}`),
            steps: sameShape ? tasks[i].steps : undefined,
            state: t.state === "done" ? "done" : t.state === "current" ? "current" : "todo",
        }));
    }
    const current = task && task.unit === "task"
        ? { index: task.index, total: task.total, done: task.tasksDone ?? 0, complete: Boolean(task.complete) }
        : undefined;
    return { title: fromDoc?.title, tasks, steps: fromDoc?.steps, current };
}
//# sourceMappingURL=plan.js.map