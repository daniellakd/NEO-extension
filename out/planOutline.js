"use strict";
/**
 * The plan's shape: its high-level tasks, and which checklist steps belong to each.
 *
 * NEO's plans (skills/writing-plans) are a handful of `### Task N: Title` headings, each over a few
 * `- [ ] **Step N: ...**` boxes. The backend's `plan_progress` counts the boxes - so on its own it
 * says "step 37 of 101". This file lays that count back over the plan to say "Task 4 of 10 · Split
 * logic", and keeps the plain checklist reading for plans that have no task headings.
 *
 * No VS Code API in here, on purpose: it is unit-tested directly (src/test/planOutline.test.ts).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePlanTasks = parsePlanTasks;
exports.planTitles = planTitles;
exports.cleanTitle = cleanTitle;
exports.parsePlanOutline = parsePlanOutline;
exports.taskStates = taskStates;
exports.furthest = furthest;
exports.currentTask = currentTask;
exports.worktreeDir = worktreeDir;
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
// --- tasks and their steps ------------------------------------------------------------------------
// Exactly the backend's rule (orchestrator checks.UNCHECKED_BOX / CHECKED_BOX): a `-` or `*` bullet,
// then `[ ]` or `[x]` - inside code fences too. Counting what it counts is what lets its
// `{done, total}` be laid over these steps one to one.
const STEP_BOX = /^[ \t]*[-*][ \t]*\[([ \txX])\]/;
// "### Task 3: Implement CRUD routes", "## Task 3 - ...", "#### Task 3. ...", "### Task 3"
const TASK_HEADING = /^(#{1,6})[ \t]+task[ \t]+\d+\b[ \t]*(?:[:.)\-–—][ \t]*)?(.*?)[ \t#]*$/i;
const HEADING = /^(#{1,6})[ \t]+\S/;
const FENCE = /^[ \t]*(?:```|~~~)/;
// "(FR-1, FR-2, NFR-5)", "(INV-PW-1..3, AC-3)": requirement references, noise in a sidebar title.
const REFERENCES = /\s*\((?=[^()]*\b[A-Z][A-Z0-9]*-[A-Z0-9])[^()]*\)/g;
/**
 * The plan's tasks and the steps under each, or null when it has no `Task N` headings.
 *
 * A step belongs to the task heading above it until a heading at the same level or higher that is
 * not a task ("## Acceptance") closes it; deeper headings inside a task do not. Headings inside code
 * fences are code (`# store.py`), but boxes there still count - the backend counts them.
 */
function parsePlanOutline(doc) {
    const tasks = [];
    const stepTask = [];
    const ticks = [];
    let fenced = false;
    let task = -1;
    let level = 0;
    for (const raw of String(doc || "").split(/\r\n?|\n/)) {
        const box = STEP_BOX.exec(raw);
        if (box) {
            stepTask.push(task);
            ticks.push(box[1] === "x" || box[1] === "X");
            continue;
        }
        if (FENCE.test(raw)) {
            fenced = !fenced;
            continue;
        }
        if (fenced)
            continue;
        const heading = TASK_HEADING.exec(raw);
        if (heading) {
            task = tasks.length;
            level = heading[1].length;
            tasks.push(taskTitle(heading[2]));
            continue;
        }
        const other = HEADING.exec(raw);
        if (other && task >= 0 && other[1].length <= level)
            task = -1;
    }
    return tasks.length ? { outline: { tasks, stepTask }, ticks } : null;
}
/** References go before the length cap does: a long list cut short would lose its ")". */
function taskTitle(raw) {
    return cleanTitle(raw.replace(REFERENCES, "")) || cleanTitle(raw);
}
/**
 * Which tasks are done: every one of their steps ticked. A task with no steps of its own cannot be
 * ticked, so it counts as done once every task before it is.
 */
function taskStates(outline, ticks) {
    const steps = outline.tasks.map(() => 0);
    const open = outline.tasks.map(() => 0);
    outline.stepTask.forEach((t, i) => {
        if (t < 0 || t >= steps.length)
            return;
        steps[t]++;
        if (!ticks[i])
            open[t]++;
    });
    let before = true;
    return outline.tasks.map((_, t) => {
        const done = steps[t] ? open[t] === 0 : before;
        before = before && done;
        return done;
    });
}
/** The copy furthest along - most boxes ticked - which is the one the backend reports too. */
function furthest(plans) {
    let best;
    let most = -1;
    for (const p of plans) {
        const n = ticked(p.ticks);
        if (n > most) {
            best = p;
            most = n;
        }
    }
    return best;
}
function ticked(ticks) {
    return ticks.reduce((n, t) => (t ? n + 1 : n), 0);
}
/**
 * The task being worked on: the first one with a step still open.
 *
 * `progress` is NEO's count and always wins on the numbers. `plans` are the outlines known - a copy
 * read from disk, the plan gate's document - and the first whose step count is NEO's total is used.
 * Its own ticks are used when they add up to NEO's `done` (so steps ticked out of order are placed
 * right); otherwise the first `done` steps are taken as the ticked ones. A plan without task headings,
 * or with a different number of steps, falls back to the checklist reading: `titles` by position.
 */
function currentTask(progress, plans, titles) {
    if (!progress || !progress.total)
        return null;
    const total = progress.total;
    const done = Math.max(0, Math.min(progress.done, total));
    const plan = plans.find((p) => Boolean(p && p.outline.stepTask.length === total));
    if (plan) {
        const ticks = ticked(plan.ticks) === done ? plan.ticks : plan.outline.stepTask.map((_, i) => i < done);
        return byTask(plan.outline, ticks);
    }
    const known = titles.length === total ? titles : [];
    if (done >= total)
        return { unit: "step", index: total, total, title: known[total - 1] };
    return { unit: "step", index: done + 1, total, title: known[done] };
}
function byTask(outline, ticks) {
    const states = taskStates(outline, ticks);
    const total = outline.tasks.length;
    const current = states.indexOf(false);
    const tasks = outline.tasks.map((title, i) => ({
        title,
        state: states[i] ? "done" : i === current ? "current" : "todo",
    }));
    const tasksDone = states.filter(Boolean).length;
    if (current < 0)
        return { unit: "task", index: total, total, tasksDone, complete: true, tasks };
    return {
        unit: "task",
        index: current + 1,
        total,
        title: outline.tasks[current] || undefined,
        tasksDone,
        complete: false,
        tasks,
    };
}
/**
 * A worktree's folder, from its `.git/worktrees/<name>/gitdir` file - which holds the path of that
 * worktree's own `.git` file. Either separator, since git on Windows writes forward slashes.
 */
function worktreeDir(gitdir) {
    const line = String(gitdir || "").split(/\r?\n/)[0].trim();
    const dir = line.replace(/[\\/]+\.git[\\/]*$/, "");
    return dir && dir !== line ? dir : null;
}
//# sourceMappingURL=planOutline.js.map