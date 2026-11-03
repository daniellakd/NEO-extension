"use strict";
/**
 * Plan progress that outlives the worktree it was counted in.
 *
 * NEO's `plan_progress` counts the ticks in the plan files on disk. While Execute runs, the
 * worktree holds them and the count is exact. Once Execute is over the worktree can be removed and
 * the ticks then live only in a branch commit, which the count does not read: a finished project
 * drops back to "0 of 18". So the sidebar keeps, per project, the furthest count it has seen for
 * the plan being executed, and uses it after Execute when NEO reports less - or nothing.
 *
 * What it never does is carry progress into a different run: the record is dropped when NEO
 * re-plans (a planning phase newer than the record) or the plan's shape changes, and while Execute
 * runs NEO's own count always replaces it.
 *
 * No VS Code API in here, on purpose: it is unit-tested directly (src/test/progressMemory.test.ts).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stageOf = stageOf;
exports.planKey = planKey;
exports.reconcile = reconcile;
exports.staleAfter = staleAfter;
/** Planning phases (a new plan is being made), Execute, and everything after it. */
function stageOf(phase) {
    const p = String(phase || "").toLowerCase();
    if (/^(setup|analysis|brainstorm|design|plan)/.test(p))
        return "before";
    if (p.startsWith("execute"))
        return "execute";
    if (/^(review|finish|merge|done)/.test(p))
        return "after";
    return undefined; // a phase this client does not know: trust NEO
}
/**
 * A plan's identity for progress: its tasks, and which step belongs to which. The ticks are left
 * out (they are the progress), and so is the step wording, which an agent may touch up while it
 * works. A plan without task headings is known by its checklist titles.
 */
function planKey(outline, titles) {
    if (outline && outline.stepTask.length)
        return `tasks:${outline.tasks.join("\u0001")}|steps:${outline.stepTask.join(",")}`;
    if (titles.length)
        return `items:${titles.join("\u0001")}`;
    return undefined;
}
/**
 * NEO's count, or the remembered one when NEO's can no longer be trusted.
 *
 * `plan` is the identity and step count of the plan known to the sidebar; `ticks` the ticks read
 * from disk, used only when they add up to NEO's count; `seq` the newest NEO event seen.
 */
function reconcile(input) {
    const { phase, plan, seq } = input;
    const backend = input.backend && input.backend.total > 0 ? clamp(input.backend) : null;
    const stage = stageOf(phase);
    // A new plan is being made: whatever was counted belonged to the last one.
    if (stage === "before")
        return { progress: backend, record: undefined, restored: false };
    // The record is only ever about the plan it was made for. Unknown plan: keep it, use nothing.
    let record = input.record;
    if (record && plan && record.plan !== plan.key)
        record = undefined;
    const usable = Boolean(record && plan);
    // What NEO says, as a record - only when it is about the plan known here.
    const counted = backend && plan && plan.steps === backend.total
        ? {
            plan: plan.key,
            done: backend.done,
            total: backend.total,
            ticks: input.ticks && input.ticks.length === backend.total && ticked(input.ticks) === backend.done ? input.ticks : undefined,
            seq,
        }
        : undefined;
    // Execute: the worktree is there and NEO's count is the truth, lower or not.
    if (stage === "execute") {
        return { progress: backend, ticks: counted?.ticks, record: keep(record, counted), restored: false };
    }
    // After Execute (or a phase not known here): NEO may have lost the worktree's ticks. Progress
    // does not go backwards within one run, so the furthest count for this plan stands.
    if (usable && record && (!backend || (backend.total === record.total && backend.done < record.done))) {
        return { progress: { done: record.done, total: record.total }, ticks: record.ticks, record, restored: true };
    }
    return { progress: backend, ticks: counted?.ticks, record: keep(record, counted), restored: false };
}
/**
 * A new count replaces the record. The same count leaves it - and its `seq` - alone, including when
 * the ticks behind it have not been read yet this time.
 */
function keep(record, counted) {
    if (!counted)
        return record;
    const same = record &&
        record.plan === counted.plan &&
        record.done === counted.done &&
        record.total === counted.total &&
        (counted.ticks === undefined || JSON.stringify(record.ticks) === JSON.stringify(counted.ticks));
    return same ? record : counted;
}
/**
 * Whether a phase NEO entered makes the record stale: a planning phase newer than the record. Old
 * events replayed on a reopen or a reconnect are older than the record and change nothing.
 */
function staleAfter(record, phase, seq) {
    if (!record || stageOf(phase) !== "before")
        return false;
    return typeof seq !== "number" || seq > record.seq;
}
function clamp(p) {
    return { done: Math.max(0, Math.min(p.done, p.total)), total: p.total };
}
function ticked(ticks) {
    return ticks.reduce((n, t) => (t ? n + 1 : n), 0);
}
//# sourceMappingURL=progressMemory.js.map