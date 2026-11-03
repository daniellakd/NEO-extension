// Current Action: what NEO is doing right now, from the tool events NEO sends. The event shapes here
// are NEO's own (orchestrator history): `pending` with nothing in it, then `running` / `completed`
// carrying `input` - an object, or a JSON string NEO cuts short when it is long.
import "./vscodeStub";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ActionTracker, commandPhrase, fileLabel, phaseAction, toolPhrase, touchesPlan } from "../progress";

const tool = (tool: string, input: unknown, extra: Record<string, unknown> = {}) => ({ kind: "tool", tool, status: "running", title: "", input, ...extra });
const bash = (command: string, description = "") => tool("bash", { command, description }, { title: description });

describe("commandPhrase - a shell command, said by what it is for", () => {
  const cases: [string, string | null][] = [
    ["PYTHONPATH=. python -m pytest -q", "Running tests"],
    ['workdir="/c/p/.worktrees/x" && cd "$workdir" && PYTHONPATH=. python3 -m pytest tests/test_auth.py', "Running tests"],
    ["npm test", "Running tests"],
    ["node --test out/test/", "Running tests"],
    ["git add -A && git commit -m 'task 2'", "Running git"],
    ["cd .worktrees/x && git status", "Running git"],
    ["pip install -r requirements.txt", "Installing dependencies"],
    ["ruff check .", "Checking code style"],
    ["cat docs/neoag/plan.md", "Inspecting files"],
    ["ls -la .worktrees/x/", "Inspecting files"],
    ["sed -n '10,20p' main.py", "Inspecting files"],
    ["sed -i 's/a/b/' main.py", "Editing files"],
    ["mkdir -p tests && touch tests/__init__.py", "Updating files"],
    ["python3 script.py", "Running a script"],
    ["python3 << 'EOF'\nwith open('logic.py') as f: x = f.read()\nEOF", "Running a script"],
    ["curl -s http://localhost:8000/users", "Calling the app"],
    ["cat > logic.py << 'EOF'\ndef f(): pass\nEOF", "Writing files"],
    ['echo "x = 1" >> docs/neoag/design.md', "Writing files"],
    ['echo "REVIEW: suite 8 passed; no stubs; no pass"', null],
    ['echo "=== acceptance ==="; python3 check.py', "Running a script"],
    ["for n in 1 2 3; do sed -n \"${n}p\" plan.md; done", "Inspecting files"],
    ["taskkill /PID 1234 /F", "Stopping a process"],
    [".neoag/wait-for 5000 http://localhost:5000/users", "Waiting for the app"],
    ["uvicorn main:app --port 8000", "Starting the app"],
  ];
  for (const [command, expected] of cases) {
    it(`${JSON.stringify(command.slice(0, 60))} -> ${expected}`, () => assert.equal(commandPhrase(command), expected));
  }

  it("NEO's own signalling is not the agent's work", () => {
    assert.equal(commandPhrase(".neoag/signal task-done"), null);
    assert.equal(commandPhrase(".worktrees/x/.neoag/signal execution-complete"), null);
    assert.equal(commandPhrase('echo "{}" | .neoag\\signal gate'), null);
  });

  it("2>&1 and > /dev/null are not file writes", () => {
    assert.equal(commandPhrase("echo hi 2>&1"), null);
    assert.equal(commandPhrase("echo hi > /dev/null"), null);
  });

  it("falls back to the agent's description, then to the generic phrase", () => {
    assert.equal(commandPhrase("./run.sh", "Run the unit tests"), "Running tests");
    assert.equal(commandPhrase("./run.sh", "Show something"), "Running a command");
  });

  it("is only ever a category: no command text in the result", () => {
    const secret = "curl -H 'Authorization: Bearer s3cr3t' http://x";
    assert.equal(commandPhrase(secret), "Calling the app");
  });
});

describe("toolPhrase - one tool event", () => {
  it("ignores the empty 'pending' update every call starts with", () => {
    assert.equal(toolPhrase({ kind: "tool", tool: "bash", status: "pending", title: "", input: {} }), null);
    assert.equal(toolPhrase({ kind: "tool", tool: "edit", status: "pending", title: "", input: {} }), null);
  });

  it("classifies bash from input.command, not from the description in the title", () => {
    assert.equal(toolPhrase(bash("PYTHONPATH=. python -m pytest -q", "Run the suite")), "Running tests");
    assert.equal(toolPhrase(bash("git log --oneline -3", "List worktree contents")), "Running git");
  });

  it("names the file from input.filePath, never a title NEO cut short", () => {
    const ev = tool("edit", { filePath: "/c/Users/x/proj/.worktrees/splitlite-medium/main.py" }, { title: "/c/Users/x/proj/.worktrees/splitlite-m…" });
    assert.equal(toolPhrase(ev), "Editing main.py");
    assert.equal(toolPhrase(tool("write", { filePath: "C:\\proj\\tests\\test_store.py" })), "Writing test_store.py");
    assert.equal(toolPhrase(tool("read", { filePath: "/workdir/docs/neoag/plan.md" })), "Reading plan.md");
  });

  it("reads a JSON-string input, including one NEO cut short", () => {
    assert.equal(toolPhrase(tool("bash", JSON.stringify({ command: "git status" }))), "Running git");
    const clipped = '{"command": "cat > /c/p/.worktrees/x/logic.py << \'EOF\'\\nfrom decimal import Decimal\\ndef split(';
    assert.equal(toolPhrase(tool("bash", clipped)), "Writing files");
    assert.equal(toolPhrase(tool("edit", '{"filePath": "/c/p/models.py", "oldString": "class U')), "Editing models.py");
  });

  it("without input or a usable title: a plain verb, not a cut-off fragment", () => {
    assert.equal(toolPhrase(tool("edit", {}, { title: "/c/x/.worktrees/splitlit…" })), "Editing a file");
    assert.equal(fileLabel("/c/x/.worktrees/splitlit…"), null);
    assert.equal(fileLabel("src/app.py"), "app.py");
  });

  it("question and skill tools in user words", () => {
    assert.equal(toolPhrase(tool("question", { questions: [] })), "Preparing a question");
    assert.equal(toolPhrase(tool("skill", { name: "implementing-tasks" })), "Loading instructions");
  });

  it("todo bookkeeping and NEO's signal say nothing", () => {
    assert.equal(toolPhrase(tool("todowrite", { todos: [] })), null);
    assert.equal(toolPhrase(bash(".neoag/signal task-done")), null);
  });
});

describe("ActionTracker - the action line over a stream of events", () => {
  it("keeps the useful action through pending updates and internal calls", () => {
    const t = new ActionTracker();
    t.note(bash("PYTHONPATH=. pytest -q"), "execute");
    t.note({ kind: "tool", tool: "bash", status: "pending", title: "", input: {} }, "execute");
    t.note(bash(".neoag/signal task-done"), "execute");
    assert.equal(t.current(), "Running tests");
  });

  it("prose does not take back a fresh tool action, and is worded by phase", () => {
    const t = new ActionTracker();
    t.note(tool("edit", { filePath: "/p/main.py" }), "execute");
    t.note({ kind: "text", text: "Now…" }, "execute");
    assert.equal(t.current(), "Editing main.py");
    const r = new ActionTracker();
    r.note({ kind: "text", text: "Looking at the diff" }, "review");
    assert.equal(r.current(), "Reviewing the implementation");
  });

  it("clears when the turn ends or the user is the one being waited on", () => {
    for (const ev of [{ kind: "idle" }, { kind: "question" }, { kind: "gate" }, { kind: "phase", phase: "review" },
      { kind: "status", busy: false }, { kind: "notice", stalled: "x" }, { kind: "notice", timeout: 1800 }, { kind: "notice", runaway: true }]) {
      const t = new ActionTracker();
      t.note(bash("git status"), "execute");
      t.note(ev, "execute");
      assert.equal(t.current(), null, JSON.stringify(ev));
    }
  });
});

describe("phaseAction", () => {
  it("names NEO's real phases, Finish included", () => {
    assert.equal(phaseAction("execute"), "Working on the task");
    assert.equal(phaseAction("review-gate"), "Reviewing the implementation");
    assert.equal(phaseAction("finish"), "Preparing the merge");
    assert.equal(phaseAction("brainstorm"), "Exploring approaches");
  });
});

describe("touchesPlan - when progress is worth re-reading early", () => {
  it("a completed edit or write of plan.md, or a command that changes it", () => {
    assert.equal(touchesPlan({ ...tool("edit", { filePath: "/p/.worktrees/x/docs/neoag/plan.md" }), status: "completed" }), true);
    assert.equal(touchesPlan({ ...bash("sed -i 's/- \\[ \\]/- [x]/' docs/neoag/plan.md"), status: "completed" }), true);
  });

  it("not reads, not running calls, not other files", () => {
    assert.equal(touchesPlan({ ...tool("read", { filePath: "/p/docs/neoag/plan.md" }), status: "completed" }), false);
    assert.equal(touchesPlan({ ...bash("cat docs/neoag/plan.md"), status: "completed" }), false);
    assert.equal(touchesPlan(tool("edit", { filePath: "/p/docs/neoag/plan.md" })), false);
    assert.equal(touchesPlan({ ...tool("edit", { filePath: "/p/main.py" }), status: "completed" }), false);
  });
});
