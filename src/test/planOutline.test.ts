// Run with `npm test`: compiled by tsc, run by node's own test runner (no extra dependencies).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  ParsedPlan,
  currentTask,
  furthest,
  parsePlanOutline,
  parsePlanTasks,
  planTitles,
  taskStates,
  worktreeDir,
} from "../planOutline";

// The shape skills/writing-plans produces: task headings over `**Step N**` boxes, code in between,
// a checklist outside the tasks at the end.
const PLAN = `# Todo CLI Implementation Plan

## Global Constraints
- Python 3.11, standard library only.

### Task 1: Todo model (FR-1, NFR-2)
- [ ] **Step 1: Write failing test for Todo**
- [ ] **Step 2: Implement Todo dataclass**

\`\`\`python
# todo.py
@dataclass
class Todo: ...
\`\`\`

### Task 2: Implement JSON Storage (FR-5, C-1)
- [ ] **Step 3: Write failing test for save/load**
#### Notes
- [ ] **Step 4: Implement storage.py**
- [ ] **Step 5: Commit**

### Task 3: CLI commands + tests
- [ ] **Step 6: add / list / done / delete**

## Acceptance
- [ ] All commands work end to end
`;

/** The plan with exactly these steps ticked (0-based, document order). */
function ticked(doc: string, steps: number[]): string {
  let n = -1;
  return doc.replace(/^([ \t]*[-*][ \t]*)\[ \]/gm, (m, lead: string) => (steps.includes(++n) ? `${lead}[x]` : m));
}

function parsed(doc: string): ParsedPlan {
  const plan = parsePlanOutline(doc);
  assert.ok(plan, "plan has task headings");
  return plan;
}

describe("parsePlanOutline - grouping steps under tasks", () => {
  it("groups each step under the task heading above it", () => {
    const { outline, ticks } = parsed(PLAN);
    assert.deepEqual(outline.tasks, ["Todo model", "Implement JSON Storage", "CLI commands + tests"]);
    assert.deepEqual(outline.stepTask, [0, 0, 1, 1, 1, 2, -1]);
    assert.deepEqual(ticks, [false, false, false, false, false, false, false]);
  });

  it("ignores headings inside code fences, but counts boxes there like the backend does", () => {
    const doc = "### Task 1: A\n```md\n# not a heading\n- [x] boxed in code\n```\n- [ ] after\n";
    const { outline, ticks } = parsed(doc);
    assert.deepEqual(outline.tasks, ["A"]);
    assert.deepEqual(outline.stepTask, [0, 0]);
    assert.deepEqual(ticks, [true, false]);
  });

  it("a deeper heading stays inside the task; a same-level non-task heading ends it", () => {
    const { outline } = parsed(PLAN);
    assert.equal(outline.stepTask[3], 1, "Step 4 is under '#### Notes', still Task 2");
    assert.equal(outline.stepTask[6], -1, "the Acceptance box belongs to no task");
  });

  it("reads the heading spellings NEO and people write", () => {
    const doc = ["## Task 1 - Dash", "### task 2. Dot", "### Task 3 — Em dash", "### Task 4", "### Task 5: `Code` **bold** ##"].join("\n");
    assert.deepEqual(parsed(doc).outline.tasks, ["Dash", "Dot", "Em dash", "", "Code bold"]);
  });

  it("drops requirement references from titles, keeps ordinary parentheses", () => {
    const doc = "### Task 1: DB layer + table (NFR-3, FR-7 reset)\n### Task 2: Store (JSON file)\n### Task 3: (AC-1)\n";
    assert.deepEqual(parsed(doc).outline.tasks, ["DB layer + table", "Store (JSON file)", "(AC-1)"]);
  });

  it("drops a reference list longer than the title cap", () => {
    const refs = Array.from({ length: 20 }, (_, i) => `FR-${i + 1}`).join(", ");
    assert.deepEqual(parsed(`### Task 2: Create endpoint + slug rules (${refs})\n`).outline.tasks, ["Create endpoint + slug rules"]);
  });

  it("handles CRLF line endings and '*' bullets", () => {
    const doc = "### Task 1: One\r\n* [x] a\r\n*[ ] b\r\n";
    const { outline, ticks } = parsed(doc);
    assert.deepEqual(outline.stepTask, [0, 0]);
    assert.deepEqual(ticks, [true, false]);
  });

  it("is null for a plan without task headings", () => {
    assert.equal(parsePlanOutline("# Plan\n- [ ] one\n- [ ] two\n"), null);
    assert.equal(parsePlanOutline(""), null);
  });
});

describe("currentTask - the first task with an open step", () => {
  const total = 7;

  it("starts at Task 1 with nothing done", () => {
    const t = currentTask({ done: 0, total }, [parsed(PLAN)], []);
    assert.equal(t?.unit, "task");
    assert.equal(t?.index, 1);
    assert.equal(t?.total, 3);
    assert.equal(t?.title, "Todo model");
    assert.equal(t?.tasksDone, 0);
    assert.equal(t?.complete, false);
  });

  it("moves to the next task only when every step of the previous one is ticked", () => {
    const plan = parsed(PLAN);
    assert.equal(currentTask({ done: 1, total }, [plan], [])?.index, 1);
    const t = currentTask({ done: 2, total }, [plan], []);
    assert.equal(t?.index, 2);
    assert.equal(t?.title, "Implement JSON Storage");
    assert.equal(t?.tasksDone, 1);
    assert.deepEqual(t?.tasks?.map((x) => x.state), ["done", "current", "todo"]);
  });

  it("uses the plan's own ticks when steps were done out of order", () => {
    // Steps 3 and 4 (Task 2) ticked, step 2 (Task 1) still open: Task 1 is current, not Task 2.
    const disk = parsed(ticked(PLAN, [0, 2, 3]));
    const t = currentTask({ done: 3, total }, [disk], []);
    assert.equal(t?.index, 1);
    assert.equal(t?.tasksDone, 0);
    assert.deepEqual(t?.tasks?.map((x) => x.state), ["current", "todo", "todo"]);
  });

  it("a later task can be done before the current one", () => {
    const disk = parsed(ticked(PLAN, [0, 1, 5]));         // Task 1 and Task 3 done, Task 2 open
    const t = currentTask({ done: 3, total }, [disk], []);
    assert.equal(t?.index, 2);
    assert.equal(t?.tasksDone, 2);
    assert.deepEqual(t?.tasks?.map((x) => x.state), ["done", "current", "done"]);
  });

  it("falls back to steps in order when the ticks known disagree with NEO's count", () => {
    const stale = parsed(ticked(PLAN, [0]));               // a copy one tick behind NEO
    const t = currentTask({ done: 3, total }, [stale], []);
    assert.equal(t?.index, 2);                             // steps 1-3 taken as ticked
    assert.equal(t?.tasksDone, 1);
  });

  it("takes the first known plan whose step count is NEO's total", () => {
    const edited = parsed(PLAN + "- [ ] one more\n");     // 8 steps: not the plan NEO is counting
    const gate = parsed(PLAN);
    assert.equal(currentTask({ done: 2, total }, [edited, gate], [])?.title, "Implement JSON Storage");
  });

  it("says every task is done when all task steps are ticked, even with loose steps open", () => {
    const disk = parsed(ticked(PLAN, [0, 1, 2, 3, 4, 5]));
    const t = currentTask({ done: 6, total }, [disk], []);
    assert.equal(t?.complete, true);
    assert.equal(t?.tasksDone, 3);
    assert.equal(t?.index, 3);
    assert.equal(t?.title, undefined);
  });

  it("handles a fully completed plan, and a count past the total", () => {
    const plan = parsed(PLAN);
    for (const done of [7, 9]) {
      const t = currentTask({ done, total }, [plan], []);
      assert.equal(t?.complete, true);
      assert.equal(t?.tasksDone, 3);
    }
  });

  it("is null without progress", () => {
    assert.equal(currentTask(null, [parsed(PLAN)], []), null);
    assert.equal(currentTask({ done: 0, total: 0 }, [parsed(PLAN)], []), null);
  });
});

describe("currentTask - plans without task headings (checklist fallback)", () => {
  const doc = "# Plan\n- [x] Scaffold\n- [ ] Implement CRUD routes\n- [ ] Write tests\n";
  const titles = planTitles(parsePlanTasks(doc), 3);

  it("names the checklist item by NEO's count", () => {
    assert.deepEqual(currentTask({ done: 1, total: 3 }, [parsePlanOutline(doc)], titles), {
      unit: "step",
      index: 2,
      total: 3,
      title: "Implement CRUD routes",
    });
  });

  it("stays on the last item when everything is done", () => {
    const t = currentTask({ done: 3, total: 3 }, [], titles);
    assert.equal(t?.index, 3);
    assert.equal(t?.title, "Write tests");
    assert.equal(t?.complete, true, "drawn as 'All 3 tasks done', not as a current task");
  });

  it("shows numbers only when the titles known are for a different plan", () => {
    const t = currentTask({ done: 1, total: 5 }, [], titles);
    assert.deepEqual(t, { unit: "step", index: 2, total: 5, title: undefined });
  });

  it("falls back too when a headed plan's step count differs from NEO's", () => {
    assert.equal(currentTask({ done: 0, total: 99 }, [parsed(PLAN)], [])?.unit, "step");
  });
});

describe("taskStates", () => {
  it("a task with no steps is done once every task before it is", () => {
    const outline = { tasks: ["a", "empty", "b"], stepTask: [0, 2] };
    assert.deepEqual(taskStates(outline, [false, false]), [false, false, false]);
    assert.deepEqual(taskStates(outline, [true, false]), [true, true, false]);
    assert.deepEqual(taskStates(outline, [true, true]), [true, true, true]);
  });
});

describe("furthest - the copy NEO reports", () => {
  it("picks the copy with the most ticks, the first on a tie", () => {
    const root = parsed(PLAN);
    const worktree = parsed(ticked(PLAN, [0, 1]));
    assert.equal(furthest([root, worktree]), worktree);
    assert.equal(furthest([root, parsed(PLAN)]), root);
    assert.equal(furthest([]), undefined);
  });
});

describe("worktreeDir - .git/worktrees/<name>/gitdir", () => {
  it("reads Windows paths with either separator", () => {
    assert.equal(worktreeDir("C:/Users/me/proj/.worktrees/feat/.git\n"), "C:/Users/me/proj/.worktrees/feat");
    assert.equal(worktreeDir("C:\\Users\\me\\proj\\.worktrees\\feat\\.git\r\n"), "C:\\Users\\me\\proj\\.worktrees\\feat");
  });

  it("reads POSIX and relative paths", () => {
    assert.equal(worktreeDir("/home/me/proj-feat/.git"), "/home/me/proj-feat");
    assert.equal(worktreeDir("../../../.worktrees/feat/.git"), "../../../.worktrees/feat");
  });

  it("rejects anything that is not a .git path", () => {
    assert.equal(worktreeDir(""), null);
    assert.equal(worktreeDir("/home/me/proj"), null);
    assert.equal(worktreeDir(".git"), null);
  });
});
