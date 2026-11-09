// Which work the Changes view compares (src/changes.ts), against real git repositories in temp
// folders: NEO worktrees whatever their branch is called, a base branch that is not `master`, work
// on a branch in the project folder itself, merges scoped to the session, and failures that say why.
// git is only written to here, to build the fixtures; the code under test only reads.
import "./vscodeStub";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { computeChanges } from "../changes";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) {
    try {
      f();
    } catch {
      // A temp folder left behind is harmless.
    }
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-changes-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

/** git for the fixture, with a fixed identity and (optionally) a fixed commit time. */
function git(cwd: string, args: string[], at?: number): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  if (at !== undefined) env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = `@${at} +0000`;
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, env, encoding: "utf8" });
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A repository whose first branch is `base`, with one commit (and .worktrees ignored, as NEO does). */
function repo(base: string): string {
  const root = tempDir();
  git(root, ["init", "-q"]);
  git(root, ["symbolic-ref", "HEAD", `refs/heads/${base}`]);
  write(path.join(root, ".gitignore"), ".worktrees/\n");
  write(path.join(root, "app.py"), "print('hi')\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"], 1_000_000);
  return root;
}

describe("Changes: which work is compared, and with what", () => {
  it("a quick change's worktree on feature/health, compared with main - uncommitted edits too", async () => {
    const root = repo("main");
    const tree = path.join(root, ".worktrees", "health");
    git(root, ["worktree", "add", "-q", "-b", "feature/health", tree, "main"]);
    write(path.join(tree, "health.py"), "def health():\n    return 'ok'\n");
    git(tree, ["add", "."]);
    git(tree, ["commit", "-q", "-m", "health"]);
    write(path.join(tree, "app.py"), "print('hi')\nprint('more')\n");    // not committed yet

    const s = await computeChanges(root);
    assert.equal(s.error, undefined);
    assert.equal(s.source, "work");
    assert.equal(s.label, "feature/health vs main");
    assert.deepEqual(s.files.map((f) => `${f.status} ${f.path}`), ["M app.py", "A health.py"]);
    assert.equal(s.baseName, "main");
    assert.equal(fs.realpathSync.native(s.repo!), fs.realpathSync.native(tree), "diffs open from the worktree");
  });

  it("never compares with a master that does not exist (the project folder on an unborn master)", async () => {
    const root = repo("main");
    const tree = path.join(root, ".worktrees", "todo");
    git(root, ["worktree", "add", "-q", "-b", "work/todo", tree, "main"]);
    write(path.join(tree, "todo.py"), "x = 1\n");
    git(tree, ["add", "."]);
    git(tree, ["commit", "-q", "-m", "todo"]);
    // The folder itself moves to a branch with no commits: before, this made it `git merge-base master`.
    git(root, ["checkout", "-q", "--orphan", "master"]);

    const s = await computeChanges(root);
    assert.equal(s.error, undefined);
    assert.equal(s.label, "work/todo vs main");
    assert.deepEqual(s.files.map((f) => f.path), ["todo.py"]);
  });

  it("uses whatever the base is called: a trunk-only repository", async () => {
    const root = repo("trunk");
    const tree = path.join(root, ".worktrees", "v");
    git(root, ["worktree", "add", "-q", "-b", "feature/version", tree, "trunk"]);
    write(path.join(tree, "version.py"), "V = '1'\n");
    const s = await computeChanges(root);
    assert.equal(s.label, "feature/version vs trunk");
    assert.deepEqual(s.files.map((f) => `${f.path}${f.untracked ? " (new)" : ""}`), ["version.py (new)"]);
  });

  it("work on a branch checked out in the project folder itself (no worktree)", async () => {
    const root = repo("main");
    git(root, ["checkout", "-q", "-b", "feature/version"]);
    write(path.join(root, "version.py"), "V = '1'\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "version"]);
    const s = await computeChanges(root);
    assert.equal(s.source, "work");
    assert.equal(s.label, "feature/version vs main");
    assert.equal(s.repo, root);
    assert.deepEqual(s.files.map((f) => f.path), ["version.py"]);
  });

  it("a removed worktree NEO left registered is skipped, not read", async () => {
    const root = repo("main");
    const tree = path.join(root, ".worktrees", "gone");
    git(root, ["worktree", "add", "-q", "-b", "work/gone", tree, "main"]);
    fs.rmSync(tree, { recursive: true, force: true });
    const s = await computeChanges(root);
    assert.equal(s.error, undefined);
    assert.equal(s.source, "none");
  });

  it("after Finish: the merge this session made - any branch name - and not an earlier session's", async () => {
    const root = repo("main");
    git(root, ["checkout", "-q", "-b", "feature/health"]);
    write(path.join(root, "health.py"), "ok = True\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "health"], 2_000_000);
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "-q", "--no-ff", "-m", "Merge branch 'feature/health'", "feature/health"], 2_000_100);

    const merged = await computeChanges(root, 1_999_000);
    assert.equal(merged.source, "merged");
    assert.match(merged.label, /^feature\/health merged into main/);
    assert.deepEqual(merged.files.map((f) => f.path), ["health.py"]);

    // A session that started after that merge has not merged anything yet: it says so.
    const later = await computeChanges(root, 3_000_000);
    assert.equal(later.source, "none");
    assert.equal(later.files.length, 0);
    assert.match(later.label, /nothing was merged into main since this session started/);
  });

  it("a folder that is not a git repository is an error that says so, not '0 files'", async () => {
    const plain = tempDir();
    await assert.rejects(computeChanges(plain), /the project folder is not a git repository/);
  });

  it("a project folder that does not exist is said as such, not as git missing", async () => {
    await assert.rejects(computeChanges(path.join(tempDir(), "nope")), /does not exist/);
  });
});
