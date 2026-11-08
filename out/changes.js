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
exports.ChangesController = void 0;
exports.changesPhase = changesPhase;
exports.worktrees = worktrees;
exports.computeChanges = computeChanges;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const workspace_1 = require("./workspace");
/**
 * What NEO produced: the files the current work changed, with native diffs of each.
 *
 * NEO's own /diff compares the project root with main, and the root stays on main while Execute
 * works in `<project>/.worktrees/<name>` on `work/<name>` — so it is empty exactly when the user
 * needs it. The extension runs on the same machine and reads git itself:
 *
 *   - while the worktree exists: its working tree against the point it branched from main, so
 *     uncommitted edits count too;
 *   - after Finish has merged and removed it: the merge commit NEO left on main, against its
 *     first parent.
 *
 * Read-only throughout: `execFile` (no shell), an allow-list of reading commands, and both sides
 * of a diff are virtual documents. Nothing is ever written to the project or its worktree — NEO
 * restores a gate's tree and deletes files it did not expect.
 */
const SCHEME = "neo-changes";
// Phases in which there is work to show. Before Execute there is no worktree and nothing changed.
const RELEVANT = new Set(["execute", "review", "review-gate", "finish", "done"]);
/** Whether NEO's work in this phase has changes to show (from Execute on). */
function changesPhase(phase) {
    return Boolean(phase && RELEVANT.has(phase));
}
// How often a live view is recomputed (the sidebar posts state many times a second while NEO
// streams); a finished one hardly ever changes.
const LIVE_INTERVAL_MS = 5_000;
const DONE_INTERVAL_MS = 60_000;
const MAX_FILES = 300;
const MAX_COUNTED_BYTES = 2 * 1024 * 1024;
const READ_ONLY = new Set(["worktree", "diff", "show", "log", "merge-base", "rev-parse", "ls-files"]);
class GitError extends Error {
}
function git(cwd, args) {
    if (!READ_ONLY.has(args[0]) || (args[0] === "worktree" && args[1] !== "list")) {
        return Promise.reject(new GitError(`git ${args[0]} is not a read-only command`));
    }
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)("git", ["--no-pager", "-c", "color.ui=false", "-c", "core.quotepath=false", ...args], {
            cwd,
            timeout: 20_000,
            maxBuffer: 32 * 1024 * 1024,
            windowsHide: true,
            // No optional index lock: the agent may be committing in the same repository.
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        }, (err, stdout, stderr) => {
            if (err) {
                const missing = err.code === "ENOENT";
                reject(new GitError(missing ? "git was not found on PATH" : (stderr || err.message).trim()));
            }
            else {
                resolve(stdout);
            }
        });
    });
}
async function worktrees(projectPath) {
    const out = await git(projectPath, ["worktree", "list", "--porcelain"]);
    const list = [];
    for (const line of out.split(/\r?\n/)) {
        if (line.startsWith("worktree "))
            list.push({ path: path.normalize(line.slice(9)), branch: null });
        else if (line.startsWith("branch ") && list.length)
            list[list.length - 1].branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
    const root = list.find((w) => (0, workspace_1.normalizePath)(w.path) === (0, workspace_1.normalizePath)(projectPath)) ?? list[0] ?? null;
    const inside = (0, workspace_1.normalizePath)(path.join(projectPath, ".worktrees")) + path.sep;
    const work = list.find((w) => w !== root && (0, workspace_1.normalizePath)(w.path).startsWith(inside)) ?? null;
    return { root, work };
}
/** `git diff --numstat` and `--name-status` together: one entry per path, renames followed. */
async function diffFiles(cwd, revs) {
    const [numstat, names] = await Promise.all([
        git(cwd, ["diff", "--numstat", "-z", "-M", ...revs, "--"]),
        git(cwd, ["diff", "--name-status", "-z", "-M", ...revs, "--"]),
    ]);
    const files = new Map();
    let parts = names.split("\0");
    for (let i = 0; i < parts.length;) {
        const code = parts[i++];
        if (!code)
            continue;
        const status = code[0];
        const oldPath = status === "R" || status === "C" ? parts[i++] : undefined;
        const p = parts[i++];
        if (p)
            files.set(p, { path: p, oldPath, status, additions: 0, deletions: 0 });
    }
    parts = numstat.split("\0");
    for (let i = 0; i < parts.length;) {
        const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i++]);
        if (!m)
            continue;
        let p = m[3];
        if (p === "") {
            i++; // a rename: the old path, then the new one
            p = parts[i++];
        }
        const f = files.get(p) ?? { path: p, status: "M", additions: 0, deletions: 0 };
        f.additions = m[1] === "-" ? null : Number(m[1]);
        f.deletions = m[2] === "-" ? null : Number(m[2]);
        files.set(p, f);
    }
    return [...files.values()];
}
/** A file git does not know yet: every line is an addition, unless it is binary. */
async function untrackedFile(root, rel) {
    const f = { path: rel, status: "A", additions: 0, deletions: 0, untracked: true };
    try {
        const uri = vscode.Uri.file(path.join(root, rel));
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_COUNTED_BYTES)
            return { ...f, additions: null, deletions: null };
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (bytes.subarray(0, 8000).includes(0))
            return { ...f, additions: null, deletions: null };
        const text = new TextDecoder("utf-8").decode(bytes);
        f.additions = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
    }
    catch {
        /* gone between listing and reading: counted as empty */
    }
    return f;
}
function summarize(project, base, all) {
    all.sort((a, b) => a.path.localeCompare(b.path));
    const files = all.slice(0, MAX_FILES);
    return {
        project,
        ...base,
        files,
        additions: all.reduce((n, f) => n + (f.additions ?? 0), 0),
        deletions: all.reduce((n, f) => n + (f.deletions ?? 0), 0),
        truncated: all.length > files.length,
    };
}
async function computeChanges(projectPath) {
    const { root, work } = await worktrees(projectPath);
    const baseBranch = root?.branch ?? "main";
    if (work) {
        // Where the work left main, and everything since — committed or not — in the worktree.
        const baseRef = (await git(work.path, ["merge-base", baseBranch, "HEAD"])).trim();
        const tracked = await diffFiles(work.path, [baseRef]);
        const others = (await git(work.path, ["ls-files", "--others", "--exclude-standard", "-z"]))
            .split("\0")
            .filter(Boolean);
        const untracked = await Promise.all(others.slice(0, MAX_FILES).map((rel) => untrackedFile(work.path, rel)));
        const branch = work.branch ?? "the worktree";
        return summarize(projectPath, {
            source: "work",
            label: `${branch} vs ${baseBranch}`,
            repo: work.path,
            baseRef,
            baseName: baseBranch,
            targetName: branch,
        }, [...tracked, ...untracked]);
    }
    // No worktree: the work was merged (or never started). NEO's Finish merges `work/<name>` with a
    // merge commit, so the newest one on the base branch's own line is this work's final result.
    const log = await git(projectPath, ["log", "--first-parent", "--merges", "-n", "50", "--format=%H%x00%P%x00%s", baseBranch]);
    for (const line of log.split("\n")) {
        const [sha, parents, subject] = line.split("\0");
        if (!sha || !/^Merge branch '(work\/[^']+)'/.test(subject ?? ""))
            continue;
        const branch = /^Merge branch '([^']+)'/.exec(subject)[1];
        const firstParent = parents.split(" ")[0];
        const files = await diffFiles(projectPath, [firstParent, sha]);
        return summarize(projectPath, {
            source: "merged",
            label: `${branch} merged into ${baseBranch} (${sha.slice(0, 7)})`,
            repo: projectPath,
            baseRef: firstParent,
            baseName: `${baseBranch} before the merge`,
            targetRef: sha,
            targetName: `merge ${sha.slice(0, 7)}`,
        }, files);
    }
    return summarize(projectPath, { source: "none", label: "" }, []);
}
/**
 * Keeps one snapshot of the current project's changes, recomputed as NEO works, and opens diffs
 * and files on request. The sidebar calls `update` on every state post; it is a cheap no-op
 * unless the project or phase changed or the interval elapsed.
 */
class ChangesController {
    post;
    snapshot = null;
    posted = "";
    key = "";
    projectPath;
    last = 0;
    running = false;
    rerun = false;
    registration;
    constructor(post) {
        this.post = post;
        this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
            provideTextDocumentContent: (uri) => this.content(uri),
        });
    }
    dispose() {
        this.registration.dispose();
    }
    update(project, phase) {
        const relevant = Boolean(project && phase && RELEVANT.has(phase));
        const key = relevant ? `${project.path}|${phase}` : "";
        if (!relevant) {
            this.key = key;
            this.projectPath = undefined;
            if (this.snapshot) {
                this.snapshot = null;
                this.publish();
            }
            return;
        }
        const interval = phase === "done" ? DONE_INTERVAL_MS : LIVE_INTERVAL_MS;
        if (key === this.key && Date.now() - this.last < interval)
            return;
        this.key = key;
        this.projectPath = project.path;
        void this.run();
    }
    /** The changes last computed for this project, or null while there are none (yet). */
    current(projectPath) {
        const s = this.snapshot;
        return s && projectPath && (0, workspace_1.normalizePath)(s.project) === (0, workspace_1.normalizePath)(projectPath) ? s : null;
    }
    /** Handles "changes.*" messages; true if it was one. */
    async onMessage(m) {
        switch (m.type) {
            case "changes.ready":
                this.posted = ""; // the webview reloaded: send what we have again
                this.publish();
                return true;
            case "changes.refresh":
                this.last = 0;
                void this.run();
                return true;
            case "changes.diff":
                if (m.path)
                    await this.openDiff(m.path);
                return true;
            case "changes.openFile":
                await this.openFile(m.file, m.title);
                return true;
            default:
                return false;
        }
    }
    async run() {
        if (this.running) {
            this.rerun = true;
            return;
        }
        const projectPath = this.projectPath;
        const key = this.key;
        if (!projectPath)
            return;
        this.running = true;
        this.last = Date.now();
        let next;
        try {
            next = await computeChanges(projectPath);
        }
        catch (err) {
            next = { project: projectPath, source: "none", label: "", files: [], additions: 0, deletions: 0, truncated: false, error: err instanceof Error ? err.message : String(err) };
        }
        this.running = false;
        if (key === this.key) {
            this.snapshot = next;
            this.publish();
        }
        if (this.rerun || key !== this.key) {
            this.rerun = false;
            void this.run();
        }
    }
    publish() {
        const message = { type: "changes", snapshot: this.snapshot };
        const sig = JSON.stringify(message);
        if (sig === this.posted)
            return; // unchanged: spare the webview a redraw
        this.posted = sig;
        this.post(message);
    }
    // --- diffs and files ------------------------------------------------------------------------
    async openDiff(rel) {
        const s = this.snapshot;
        const f = s?.files.find((x) => x.path === rel);
        if (!s || !f || !s.repo || !s.baseRef) {
            void vscode.window.showWarningMessage("NEO: that change is no longer in the list. Refresh the Changes view.");
            return;
        }
        const nonce = String(Date.now()); // the work side changes while NEO works: never reuse a cached copy
        const side = (query, p) => vscode.Uri.from({ scheme: SCHEME, path: "/" + p, query: JSON.stringify({ ...query, v: nonce }) });
        const empty = (p) => side({ empty: "1" }, p);
        const left = f.status === "A" ? empty(f.path) : side({ repo: s.repo, ref: s.baseRef, file: f.oldPath ?? f.path }, f.oldPath ?? f.path);
        const right = f.status === "D"
            ? empty(f.path)
            : s.targetRef
                ? side({ repo: s.repo, ref: s.targetRef, file: f.path }, f.path)
                : side({ disk: path.join(s.repo, f.path) }, f.path);
        const title = `${path.posix.basename(f.path)} (${s.baseName} ↔ ${s.targetName})`;
        await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
    }
    /** A diff side: a blob from git, a file from the worktree read as it is now, or nothing. */
    async content(uri) {
        let q;
        try {
            q = JSON.parse(uri.query);
        }
        catch {
            return "";
        }
        if (q.empty)
            return "";
        try {
            let text;
            if (q.disk) {
                text = new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(vscode.Uri.file(q.disk)));
            }
            else if (q.repo && q.ref && q.file) {
                text = await git(q.repo, ["show", `${q.ref}:${q.file}`]);
            }
            else {
                return "";
            }
            return text.includes("\u0000") ? "(binary file — no text diff)" : text;
        }
        catch (err) {
            return `(not available: ${err instanceof Error ? err.message : String(err)})`;
        }
    }
    /**
     * Open a file a tool row mentions. Its path may point into a worktree Finish has since removed,
     * so it falls back to the same relative path in the project.
     */
    async openFile(file, title) {
        const projectPath = this.projectPath ?? this.snapshot?.project;
        const candidates = [];
        if (file)
            candidates.push(path.isAbsolute(file) ? file : projectPath ? path.join(projectPath, file) : file);
        const rel = file && projectPath ? relativeToProject(file, projectPath) : title;
        if (rel && projectPath) {
            if (this.snapshot?.source === "work" && this.snapshot.repo)
                candidates.push(path.join(this.snapshot.repo, rel));
            candidates.push(path.join(projectPath, rel));
        }
        for (const candidate of candidates) {
            try {
                const uri = vscode.Uri.file(candidate);
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type & vscode.FileType.Directory)
                    continue;
                await vscode.window.showTextDocument(uri, { preview: true });
                return;
            }
            catch {
                /* try the next */
            }
        }
        void vscode.window.showWarningMessage(`NEO: ${title || file || "that file"} no longer exists.`);
    }
}
exports.ChangesController = ChangesController;
/** A path inside the project or one of its worktrees, made relative to that tree. */
function relativeToProject(file, projectPath) {
    if (!path.isAbsolute(file))
        return file;
    const rel = path.relative(projectPath, file);
    if (rel.startsWith("..") || path.isAbsolute(rel))
        return undefined;
    const parts = rel.split(/[\\/]/);
    // .worktrees/<name>/x/y -> x/y
    return parts[0] === ".worktrees" && parts.length > 2 ? parts.slice(2).join(path.sep) : rel;
}
//# sourceMappingURL=changes.js.map