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

import * as path from "path";
import * as vscode from "vscode";
import type { NeoEvent } from "./neoClient";
import {
  CurrentTask,
  ParsedPlan,
  PlanOutline,
  PlanProgress,
  currentTask,
  furthest,
  parsePlanOutline,
  parsePlanTasks,
  planTitles,
  worktreeDir,
} from "./planOutline";
import { ProgressRecord, planKey, reconcile, staleAfter } from "./progressMemory";

export type { CurrentTask } from "./planOutline";

// --- the picture the webview draws ----------------------------------------------------------

export type Activity =
  | "offline"
  | "loading"
  | "idle"
  | "working"
  | "stopping"
  | "stopped"
  | "awaiting"
  | "gate"
  | "attention"
  | "done";

export interface LiveNote {
  tone: "info" | "warn" | "ok";
  text: string;
}

export interface LiveView {
  activity: Activity;
  /** A few words for the line under the input. */
  label: string;
  /** The same thing said in full, for a tooltip. */
  detail: string;
  task: CurrentTask | null;
  progress: { done: number; total: number } | null;
  /** "Editing main.py" - the latest meaningful action, only while NEO is working. */
  action: string | null;
  note: LiveNote | null;
  stream: { state: "off" | "up" | "reconnecting"; retryAt?: number; catchingUp?: boolean };
  canStop: boolean;
  stopHint: string;
}

/** What `buildLive` needs. `ViewState` satisfies this structurally. */
export interface LiveInput {
  connection: "connecting" | "connected" | "reconnecting" | "unreachable";
  mode: "loading" | "noFolder" | "noProject" | "project";
  phase?: string;
  busy: boolean;
  atGate: boolean;
  awaiting: boolean;
  stopping: boolean;
  stoppedAt?: number;
  needsAttention: boolean;
  attentionReason: string | null;
  /** The user's Stop ended the last turn, and no new turn has started since. */
  userStopped?: boolean;
  planProgress: { done: number; total: number } | null;
  stream: "off" | "up" | "reconnecting";
  streamRetryAt?: number;
  catchingUp: boolean;
}

export const STOP_HINT =
  "Stop what NEO is doing now. The running turn is aborted - nothing already written is undone " +
  "and the project stays in this phase. Afterwards you can send a new message or answer.";

// --- plan document --------------------------------------------------------------------------

export { parsePlanTasks, planTitles } from "./planOutline";

interface PlanMemory {
  artifactPath?: string;
  /** Checklist items, for a plan without task headings. */
  titles: string[];
  /** The plan's tasks and which step belongs to which (src/planOutline.ts). */
  outline?: PlanOutline;
  /** The furthest count seen for this plan, for after the worktree is gone (src/progressMemory.ts). */
  progress?: ProgressRecord;
}

/** What the live panel shows of the plan. */
export interface PlanView {
  progress: PlanProgress | null;
  task: CurrentTask | null;
}

/** Whether a gate's document is the plan: the phase says so, or its checklist is the one counted. */
function looksLikePlan(phase: string | undefined, artifactPath: string | undefined, items: number, total?: number): boolean {
  const p = String(phase || "").toLowerCase();
  if (/^plan(-|$)/.test(p)) return true;
  if (/plan/i.test(String(artifactPath || ""))) return true;
  return Boolean(total && items === total && items > 1);
}

// Where NEO keeps the plan, relative to a project or worktree folder (orchestrator checks._plan_file).
// `forge` is the pre-rename directory, still on disk in older projects.
const PLAN_FILES = [["docs", "neoag", "plan.md"], ["docs", "forge", "plan.md"]];

/**
 * Remembers the plan of the selected project, so "Task 3 of 8 - Implement CRUD routes" survives
 * the plan gate scrolling out of the history window and the webview reloading.
 *
 * The plan's shape comes from the open gate's document, a `gate` event in the history, or the plan
 * file. Which steps are ticked comes from the plan files on disk - the project's and every git
 * worktree's, as the backend reads them - re-read only when NEO's count moves. Everything goes
 * through the VS Code file API: no shell, no separator assumptions.
 *
 * All of it is kept per project in `globalState`, the furthest count included, so a reopened
 * window, a reconnect or a switch back to the project shows the same task and progress - and a
 * finished project whose worktree is gone does not fall back to 0%.
 */
export class PlanTracker {
  private projectId: string | undefined;
  private projectPath: string | undefined;
  private memory: PlanMemory = { titles: [] };
  /** The copy on disk furthest along, ticks and all. */
  private disk: ParsedPlan | undefined;
  /** The `done/total` the disk was last read for: a failed read is not retried every poll. */
  private readFor: string | undefined;
  private reading = false;

  constructor(private readonly store: vscode.Memento | undefined, private readonly onChange: () => void) {}

  /** Select a project: load whatever was remembered about its plan last time. */
  start(projectId: string, projectPath: string): void {
    this.projectId = projectId;
    this.projectPath = projectPath;
    this.reading = false;
    this.disk = undefined;
    this.readFor = undefined;
    this.memory = this.store?.get<PlanMemory>(this.key(projectId)) ?? { titles: [] };
  }

  stop(): void {
    this.projectId = undefined;
    this.projectPath = undefined;
    this.memory = { titles: [] };
    this.disk = undefined;
    this.readFor = undefined;
  }

  /** A gate - live event or open-gate state. Only the plan's document is kept. */
  noteGate(phase: string | undefined, artifactPath: string | undefined, artifact: unknown, total?: number): void {
    if (typeof artifact !== "string" || !artifact.trim()) return;
    const tasks = parsePlanTasks(artifact);
    if (!tasks.length) return;
    if (!looksLikePlan(phase, artifactPath, tasks.length, total)) return;
    this.remember({
      ...this.memory,
      artifactPath: artifactPath || this.memory.artifactPath,
      titles: planTitles(tasks, total),
      outline: parsePlanOutline(artifact)?.outline,
    });
  }

  /** The plan as NEO's own file. */
  private noteDoc(doc: string, total: number): void {
    const tasks = parsePlanTasks(doc);
    if (!tasks.length) return;
    this.remember({
      ...this.memory,
      titles: planTitles(tasks, total),
      outline: parsePlanOutline(doc)?.outline,
    });
  }

  /**
   * A phase NEO entered (live, caught up, or in the history read on open). A planning phase newer
   * than the remembered count means a new plan: the count belonged to the last one.
   */
  notePhase(phase: string | undefined, seq: number | undefined): void {
    if (!staleAfter(this.memory.progress, phase, seq)) return;
    this.memory = { ...this.memory, progress: undefined };
    this.persist();
  }

  private remember(next: PlanMemory): void {
    const same = JSON.stringify(next) === JSON.stringify(this.memory);
    this.memory = next;
    this.persist();
    if (!same) this.onChange();
  }

  private persist(): void {
    if (this.projectId) void this.store?.update(this.key(this.projectId), this.memory);
  }

  /**
   * The plan as the panel shows it: NEO's count - or, after Execute, the furthest count remembered
   * for this plan when NEO's has dropped (src/progressMemory.ts) - and "Task 2 of 5 - Implement
   * JSON storage", the first task with a step still open (src/planOutline.ts).
   *
   * `seq` is the newest NEO event seen: it dates the remembered count. `session` is the NEO work
   * session on screen: a count remembered for another session is never shown for this one.
   */
  view(backend: PlanProgress | null | undefined, phase: string | undefined, seq: number, session?: string): PlanView {
    if (backend && backend.total) this.refresh(backend);
    const outline = this.disk?.outline ?? this.memory.outline;
    const key = planKey(outline, this.memory.titles);
    const plan = key ? { key, steps: outline ? outline.stepTask.length : this.memory.titles.length } : undefined;
    const r = reconcile({ backend, phase, plan, ticks: this.disk?.ticks, seq, record: this.memory.progress, session });
    if (r.record !== this.memory.progress) {
      this.memory = { ...this.memory, progress: r.record };
      this.persist();
    }
    if (!r.progress) return { progress: null, task: null };
    const known = r.ticks && outline ? { outline, ticks: r.ticks } : undefined;
    const remembered = this.memory.outline
      ? { outline: this.memory.outline, ticks: this.memory.outline.stepTask.map(() => false) }
      : undefined;
    return { progress: r.progress, task: currentTask(r.progress, [known, this.disk, remembered], this.memory.titles) };
  }

  /**
   * Re-read the plan files when NEO's count has moved - a step was ticked, or the plan changed. Each
   * count is read for once, failures included: a missing file is not re-read every poll, and when NEO
   * runs on another machine the reads simply fail and the count alone is used.
   */
  private refresh(progress: { done: number; total: number }): void {
    const key = `${progress.done}/${progress.total}`;
    if (key === this.readFor || this.reading || !this.projectPath) return;
    this.readFor = key;
    this.reading = true;
    const project = this.projectId;
    void (async () => {
      try {
        const found: { doc: string; plan: ParsedPlan }[] = [];
        for (const file of await this.planFiles()) {
          try {
            const doc = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
            const plan = parsePlanOutline(doc);
            found.push({ doc, plan: plan ?? { outline: { tasks: [], stepTask: [] }, ticks: [] } });
          } catch {
            // Not there (no worktree yet, an older layout): the other copies still count.
          }
        }
        if (project !== this.projectId || !found.length) return;
        const best = furthest(found.map((f) => f.plan));
        const doc = found.find((f) => f.plan === best)?.doc ?? found[0].doc;
        const changed = JSON.stringify(best) !== JSON.stringify(this.disk);
        this.disk = best && best.outline.tasks.length ? best : undefined;
        this.noteDoc(doc, progress.total);
        if (changed) this.onChange();
      } finally {
        this.reading = false;
      }
    })();
  }

  /** Every place a copy of the plan can be: the remembered path, the usual ones, each worktree's. */
  private async planFiles(): Promise<vscode.Uri[]> {
    if (!this.projectPath) return [];
    const root = vscode.Uri.file(this.projectPath);
    const files: vscode.Uri[] = [];
    const remembered = this.planUri();
    if (remembered) files.push(remembered);
    for (const parts of PLAN_FILES) files.push(vscode.Uri.joinPath(root, ...parts));
    for (const tree of await worktrees(root)) files.push(vscode.Uri.joinPath(tree, ...PLAN_FILES[0]));
    const seen = new Set<string>();
    return files.filter((f) => {
      const id = f.toString().toLowerCase();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  /** The remembered plan path, as a URI. Relative paths hang off the project folder. */
  private planUri(): vscode.Uri | undefined {
    const rel = this.memory.artifactPath;
    if (!rel || !this.projectPath) return undefined;
    if (path.isAbsolute(rel)) return vscode.Uri.file(rel);
    const parts = rel.split(/[\\/]+/).filter((p) => p && p !== ".");
    if (!parts.length || parts.includes("..")) return undefined;
    return vscode.Uri.joinPath(vscode.Uri.file(this.projectPath), ...parts);
  }

  private key(projectId: string): string {
    return `neo.plan.${projectId}`;
  }
}

/**
 * The project's git worktrees: each `.git/worktrees/<name>/gitdir` names one - the same records
 * `git worktree list` reads, the backend's source for where an agent is ticking the plan.
 */
async function worktrees(root: vscode.Uri): Promise<vscode.Uri[]> {
  const admin = vscode.Uri.joinPath(root, ".git", "worktrees");
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(admin);
  } catch {
    return [];                                     // not a repository, or no worktrees
  }
  const trees: vscode.Uri[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) continue;
    try {
      const gitdir = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(admin, name, "gitdir"))).toString("utf8");
      const dir = worktreeDir(gitdir);
      if (!dir) continue;
      // Absolute on either platform, or (newer git, worktree.useRelativePaths) relative to the record.
      const absolute = path.win32.isAbsolute(dir) || path.posix.isAbsolute(dir);
      trees.push(absolute ? vscode.Uri.file(dir) : vscode.Uri.joinPath(admin, name, ...dir.split(/[\\/]+/)));
    } catch {
      // A record without its gitdir file: a pruned worktree.
    }
  }
  return trees;
}

// --- what NEO is doing right now --------------------------------------------------------------

// Tool rows that say nothing a user wants to read. They still reach the transcript; they just do
// not become "what NEO is doing".
const QUIET_TOOLS = new Set(["todoread", "todowrite", "think", "thinking", "nothing"]);

// Once a tool has named the action, prose does not take it back for this long: a turn interleaves
// text and tool calls constantly, and the line must not flicker.
const TOOL_HOLD_MS = 4_000;

/** The latest meaningful action, from the events the sidebar already receives. */
export class ActionTracker {
  private text: string | null = null;
  private at = 0;
  private fromTool = false;

  reset(): void {
    this.text = null;
    this.at = 0;
    this.fromTool = false;
  }

  current(): string | null {
    return this.text;
  }

  /** Feed one event. Phase is used only for the wording of a plain thinking/writing stretch. */
  note(ev: NeoEvent, phase: string | undefined): void {
    switch (ev.kind) {
      case "tool": {
        const phrase = toolPhrase(ev);
        if (!phrase) return;
        this.text = phrase;
        this.at = Date.now();
        this.fromTool = true;
        return;
      }
      case "text": {
        if (this.fromTool && Date.now() - this.at < TOOL_HOLD_MS) return;
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
        if (ev.busy === false) this.reset();
        return;
      case "notice":
        if (ev.stalled || ev.timeout || ev.runaway) this.reset();
        return;
    }
  }
}

/**
 * "Editing main.py" out of a `tool` event - a verb and a name, never the arguments.
 *
 * NEO sends each call as `pending` (no title, no input yet), then `running` and `completed` with the
 * tool's input. The input is what names the file and the command; the title is only a fallback - for
 * `bash` it is the agent's own description of the command, and NEO cuts long ones short ("…").
 * Null means "nothing worth saying": the action shown stays as it was.
 */
export function toolPhrase(ev: NeoEvent): string | null {
  const name = toolName(ev);
  if (!name || QUIET_TOOLS.has(name)) return null;
  const title = typeof ev.title === "string" ? ev.title.trim() : "";
  const input = inputOf(ev);
  // The first update of every call carries nothing yet; a guess here would replace something better.
  if (ev.status === "pending" && !title && !Object.keys(input).length) return null;
  const file = fileOf(input) ?? fileLabel(title);

  if (/^question/.test(name)) return "Preparing a question";
  if (/^skill/.test(name)) return "Loading instructions";
  if (/^(read|view|cat|open|fileread)/.test(name)) return file ? `Reading ${file}` : "Reading a file";
  if (/^(multiedit|edit|patch|applypatch|strreplace|update)/.test(name)) return file ? `Editing ${file}` : "Editing a file";
  if (/^(write|create|filewrite|notebookedit)/.test(name)) return file ? `Writing ${file}` : "Writing a file";
  if (/^(grep|search|ripgrep|rg|glob|find|ls|list|tree)/.test(name)) return "Searching the project";
  if (/^(task|agent|subagent|dispatch|delegate)/.test(name)) return "Running a sub-agent";
  if (/^(webfetch|fetch|http|websearch|browse)/.test(name)) return "Reading documentation";
  if (/^(bash|shell|sh|exec|run|terminal|cmd|powershell|process)/.test(name)) {
    const command = typeof input.command === "string" ? input.command : "";
    return commandPhrase(command || title, command ? title : "");
  }
  // An unknown tool still reads sensibly: "Running migrate".
  return `Running ${spaced(name)}`;
}

function toolName(ev: NeoEvent): string {
  return String(ev.tool ?? "").toLowerCase().replace(/^.*__/, "").replace(/[^a-z0-9]/g, "");
}

/**
 * A tool call's input, as NEO sends it: an object, or a JSON string - which NEO cuts short when it
 * is long, so the fields that matter here are read out of the part that did arrive.
 */
function inputOf(ev: NeoEvent): Record<string, unknown> {
  const value = ev.input;
  if (typeof value !== "string") {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    const found: Record<string, unknown> = {};
    for (const key of ["command", "filePath", "file_path", "path"]) {
      const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(value);
      if (!m) continue;
      try {
        found[key] = JSON.parse(`"${m[1].replace(/\\$/, "")}"`);
      } catch {
        found[key] = m[1];
      }
    }
    return found;
  }
}

/** The file a tool works on, from its input: the full path, never NEO's shortened title. */
function fileOf(input: Record<string, unknown>): string | null {
  for (const key of ["filePath", "file_path", "path", "file"]) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const name = value.trim().split(/[\\/]+/).filter(Boolean).pop();
    if (name && name.length <= 40) return name;
  }
  return null;
}

// NEO's own signalling script: the agent reporting to the orchestrator, not work to show.
const INTERNAL_COMMAND = /\.neoag[\\/]+signal\b/;
// Programs that only look: what they look at is not worth naming.
const INSPECTS = new Set(["cat", "ls", "dir", "head", "tail", "grep", "egrep", "rg", "find", "wc", "pwd", "tree", "stat", "less", "more", "file", "type", "sort", "diff", "awk", "jq", "which", "where", "realpath", "readlink"]);
const UPDATES = new Set(["mkdir", "cp", "mv", "rm", "rmdir", "touch", "ln", "chmod", "copy", "move", "del"]);
// Lines that only set things up, or open a shell construct, for the command after them.
const SETUP = new Set(["cd", "pushd", "popd", "export", "set", "source", ".", "for", "while", "until", "if", "case", "fi", "done", "esac"]);

/**
 * What a shell command is for. Only ever a category - the command line itself is never shown.
 * `description` is the agent's own one-line summary, consulted when the command says nothing.
 * Null for NEO's internal signalling, which is not the agent's work.
 */
export function commandPhrase(command: string, description = ""): string | null {
  const c = String(command || "").toLowerCase();
  if (INTERNAL_COMMAND.test(c)) return null;
  if (/\b(pytest|jest|vitest|mocha|unittest|go test|cargo test|dotnet test|npm (run )?test|yarn test|pnpm test|rspec|phpunit)\b|\bnode --test\b/.test(c)) {
    return "Running tests";
  }
  if (/\b(eslint|ruff|flake8|pylint|black|prettier|gofmt|clippy|mypy)\b/.test(c)) return "Checking code style";
  if (/\b(tsc|webpack|make|msbuild|cargo build|go build|dotnet build)\b/.test(c) || /\b(npm|yarn|pnpm) run build\b/.test(c)) {
    return "Building the project";
  }
  if (/\b(npm (ci|install|i)|yarn add|pnpm (add|install)|pip3? install|poetry install|cargo add|go get|dotnet restore)\b/.test(c)) {
    return "Installing dependencies";
  }
  if (/\bgit\b/.test(c)) return "Running git";
  if (/\b(alembic|migrate|migration)\b/.test(c)) return "Running migrations";
  if (/\b(uvicorn|flask run|npm start|serve|docker)\b/.test(c)) return "Starting the app";
  if (/\.neoag[\\/]+wait-for\b/.test(c)) return "Waiting for the app";

  const program = firstProgram(c);
  // `echo …` / `printf …`: the agent printing to its own terminal - unless it writes a file with it.
  if (/^(echo|printf|true|:)$/.test(program)) return writesFile(c) ? "Writing files" : null;
  if ((program === "cat" && writesFile(c)) || program === "tee") return "Writing files";
  if (program === "sed") return /\s-i\b/.test(c) ? "Editing files" : "Inspecting files";
  if (INSPECTS.has(program)) return "Inspecting files";
  if (UPDATES.has(program)) return "Updating files";
  if (/^(python[0-9.]*|py|node|deno|bun|ruby|perl|php)$/.test(program)) return "Running a script";
  if (/^(curl|wget|http|httpie|invoke-webrequest)$/.test(program)) return "Calling the app";
  if (/^(kill|pkill|taskkill|stop-process)$/.test(program)) return "Stopping a process";
  if (/^(ps|lsof|netstat|tasklist|get-process)$/.test(program)) return "Checking processes";

  const d = String(description || "").toLowerCase();
  if (/\btests?\b/.test(d)) return "Running tests";
  if (/\bgit\b|\bcommit\b/.test(d)) return "Running git";
  if (/\bbuild\b/.test(d)) return "Building the project";
  if (/\binstall\b/.test(d)) return "Installing dependencies";
  return "Running a command";
}

/** Output redirected into a file (`> f`, `>> f`) - not `2>&1`, not `> /dev/null`. */
function writesFile(command: string): boolean {
  return /(^|[^0-9&>=])>{1,2}\s*(?!&|\/dev\/null\b|nul\b)["'\w.~$\\/-]/.test(command);
}

/**
 * The program a command line runs, past `cd x &&`, `VAR=value` and `workdir="…" &&` setup: the
 * first word of the first segment that does anything, without its directory.
 */
function firstProgram(command: string): string {
  let printed = "";
  // Quoted text is an argument, never a separator: `echo "a; b"` is one command.
  const bare = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  for (const segment of bare.split(/&&|\|\||;|\r?\n/)) {
    const words = segment
      .trim()
      .replace(/^(?:[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*)+/i, "")
      .replace(/^(?:(?:do|then|else|time|sudo|nohup|exec)\s+)+/, "")
      .split(/\s+/)
      .filter(Boolean);
    const word = (words[0] || "").replace(/^["'`]|["'`]$/g, "");
    if (!word || SETUP.has(word)) continue;
    const program = word.split(/[\\/]/).pop() || word;
    // `echo "step 1"; python app.py` runs python: a bare print says nothing about the command.
    if (/^(echo|printf)$/.test(program) && !writesFile(segment)) {
      printed = printed || program;
      continue;
    }
    return program;
  }
  return printed;
}

/**
 * A finished tool call that changed the plan file - a step was probably just ticked. Worth one
 * early re-read of the project, so progress moves without waiting for the 10-second one.
 */
export function touchesPlan(ev: NeoEvent): boolean {
  if (ev.kind !== "tool" || ev.status !== "completed") return false;
  const name = toolName(ev);
  if (/^(read|view|cat|open|fileread|grep|search|glob|list)/.test(name)) return false;
  const input = inputOf(ev);
  const command = typeof input.command === "string" ? input.command : "";
  if (command && commandPhrase(command) === "Inspecting files") return false;
  const target = [input.filePath, input.file_path, input.path, command].filter((v) => typeof v === "string").join(" ");
  return /(^|[\\/\s"'])plan\.md\b/i.test(target);
}

/**
 * A stretch of prose with no tool behind it, named by the phase it happens in - this is the
 * difference between "working" and "Reviewing the implementation".
 */
export function phaseAction(phase: string | undefined): string {
  const p = String(phase || "").toLowerCase();
  if (p.startsWith("analysis")) return "Analysing the project";
  if (p.startsWith("brainstorm")) return "Exploring approaches";
  if (p.startsWith("design")) return "Writing the design";
  if (p.startsWith("plan")) return "Writing the plan";
  if (p.startsWith("execute")) return "Working on the task";
  if (p.startsWith("review")) return "Reviewing the implementation";
  if (p.startsWith("finish") || p.startsWith("merge")) return "Preparing the merge";
  return "Thinking";
}

/**
 * The name in a tool's title, when the title is a path. Separator-agnostic on purpose: NEO may be
 * on Linux while the sidebar is on Windows, so neither `path.win32` nor `path.posix` is right.
 */
export function fileLabel(title: string): string | null {
  if (!title) return null;
  const first = title.split(/\s+/)[0];
  if (!/[\\/.]/.test(first) || /^https?:/i.test(first)) return null;
  const name = first.split(/[\\/]+/).filter(Boolean).pop();
  // A title NEO cut short ends mid-name ("splitlite-m…"): that is not a file name.
  if (!name || name.length > 40 || /(…|\.\.\.)$/.test(name)) return null;
  return name;
}

function spaced(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

// --- notices ------------------------------------------------------------------------------------

/** How long an informational notice stays on the live line before it is only history. */
const INFO_NOTICE_MS = 25_000;

export interface HeldNotice extends LiveNote {
  at: number;
  sticky: boolean;
}

/**
 * The few notices that describe the *current* state rather than something that happened. The
 * transcript keeps every notice; this line repeats only the one the user still has to act on.
 */
export function noticeOf(ev: NeoEvent): HeldNotice | null {
  const held = (tone: LiveNote["tone"], text: string, sticky: boolean): HeldNotice => ({
    tone,
    text,
    at: Date.now(),
    sticky,
  });
  if (ev.stalled) return held("warn", `NEO is stalled in ${String(ev.stalled)} - send guidance to continue`, true);
  if (ev.timeout) return held("warn", `No activity for ${String(ev.timeout)}s - the turn was stopped`, true);
  if (ev.runaway) return held("warn", "Runaway output - the turn was stopped", true);
  if (ev.repair_stuck) {
    return held("warn", `Automatic repair stopped on ${String(ev.repair_stuck)} - the gate is open for you`, true);
  }
  if (ev.held) return held("warn", `${String(ev.held)} is held for you: ${String(ev.failed ?? "a check did not pass")}`, true);
  if (ev.incomplete) {
    return ev.exhausted
      ? held("warn", `Execution stopped with ${String(ev.count)} plan step(s) left - waiting for you`, true)
      : held(
          "info",
          `${String(ev.count)} plan step(s) left - NEO is continuing (attempt ${String(ev.attempt)}/${String(ev.limit)})`,
          false,
        );
  }
  if (ev.resumed) return held("info", `A turn in ${String(ev.resumed)} was interrupted by a restart - NEO resumed it`, false);
  return null;                                   // everything else is history, not a live state
}

/**
 * NEO's reason for a stall that a user's Stop explains. NEO's abort ends the running turn, and NEO
 * then reports that turn as having "ended with an error" - which, right after the user pressed Stop
 * and before any new turn started, is the Stop, not a failure. Any other reason is a real problem.
 */
export function stopExplains(reason: unknown): boolean {
  return /\bended with an error\b/i.test(String(reason ?? ""));
}

/** Drop a notice that has aged out, or that a newer state has answered. */
export function liveNotice(notice: HeldNotice | null, busy: boolean): LiveNote | null {
  if (!notice) return null;
  if (!notice.sticky && Date.now() - notice.at > INFO_NOTICE_MS) return null;
  if (notice.sticky && busy) return null;        // NEO is moving again: the stall is over
  return { tone: notice.tone, text: notice.text };
}

// --- the whole picture ---------------------------------------------------------------------------

/** How long "Stopped" stays on screen after an abort takes effect. */
const STOPPED_MS = 12_000;

export function buildLive(
  s: LiveInput,
  task: CurrentTask | null,
  action: string | null,
  note: LiveNote | null,
): LiveView {
  const connected = s.connection === "connected";
  const inProject = s.mode === "project";
  const phase = s.phase ?? "";
  // "Working" is NEO running a turn - not waiting on an answer, an approval, or on nothing.
  const working = connected && inProject && s.busy && !s.awaiting && !s.atGate;
  const canStop = working && !s.stopping && phase !== "done";
  // The stall NEO reports for the turn the user just stopped (see `stopExplains`): said as the Stop.
  const stopExplained = Boolean(
    s.userStopped && !working && !s.awaiting && !s.atGate && s.needsAttention && stopExplains(s.attentionReason),
  );
  const stopped = Boolean(s.stoppedAt && Date.now() - s.stoppedAt < STOPPED_MS && !s.busy) || stopExplained;

  let activity: Activity;
  let label: string;
  let detail: string;
  if (!connected) {
    activity = "offline";
    label = s.connection === "connecting" ? "connecting" : s.connection === "reconnecting" ? "reconnecting" : "not connected";
    detail = s.connection === "reconnecting"
      ? "NEO stopped answering. The sidebar keeps trying; the project and your draft are kept."
      : "NEO is not reachable. Progress cannot be read until the connection is back.";
  } else if (!inProject) {
    activity = "loading";
    label = s.mode === "loading" ? "loading" : "";
    detail = "No NEO project selected in this window.";
  } else if (s.stopping) {
    activity = "stopping";
    label = "stopping";
    detail = "Stop was sent. NEO is ending the running turn; this takes a moment.";
  } else if (s.awaiting) {
    activity = "awaiting";
    label = "waiting for your answer";
    detail = "NEO asked a question and is waiting. Answer it above, or type your own answer below.";
  } else if (s.atGate) {
    activity = "gate";
    label = "waiting for your approval";
    detail = "NEO reached a gate. It will not continue until you approve or request changes.";
  } else if (working) {
    activity = "working";
    label = "working";
    detail = action ? `NEO is working: ${action.toLowerCase()}.` : "NEO is working on this project.";
  } else if (phase === "done") {
    activity = "done";
    label = "done";
    detail = "This project reached the end of the pipeline.";
  } else if (s.needsAttention && s.attentionReason && !stopExplained) {
    activity = "attention";
    label = "waiting on you";
    detail = `NEO stopped and is waiting on you: ${s.attentionReason}`;
  } else if (stopped) {
    activity = "stopped";
    label = "stopped";
    detail = "The turn was stopped. Nothing already written was undone - send a message to continue.";
  } else {
    activity = "idle";
    label = "idle";
    detail = "NEO is not running anything. Send a message to continue.";
  }

  // One voice for the exceptional state: NEO's own reason wins over the remembered notice, so a
  // stall is never announced twice in the same place. Not while NEO is working again: NEO clears a
  // stall the moment work resumes, and this copy of its state can be up to one re-read behind.
  const attention =
    inProject && connected && s.needsAttention && s.attentionReason && !s.awaiting && !s.atGate && !working && !stopExplained
      ? ({ tone: "warn", text: `Waiting on you: ${s.attentionReason}` } as LiveNote)
      : null;
  const stoppedNote: LiveNote | null = stopped
    ? { tone: "info", text: "Turn stopped - nothing was undone. Send a message to continue." }
    : null;

  // A plan is worth showing once there is one to be part-way through. Before Execute the plan
  // gate card itself is on screen, so an untouched "0 of 8" there would only repeat it.
  const plan = s.planProgress;
  const showPlan =
    inProject &&
    connected &&
    Boolean(plan && plan.total > 0 && (/^(execute|review|finish|merge|done)/.test(phase) || plan.done > 0));
  // Once Execute is over no task is being worked on: a finished plan reads "All N tasks done", and
  // an unfinished one shows only its count - never an old task presented as the current one.
  const afterExecute = /^(review|finish|merge|done)/.test(phase);
  const shownTask = showPlan && task && (!afterExecute || task.complete) ? task : null;

  return {
    activity,
    label,
    detail,
    task: shownTask,
    progress: showPlan ? plan : null,
    action: working ? action : null,
    note: attention ?? (inProject ? (stopExplained ? stoppedNote : note ?? stoppedNote) : null),
    stream: { state: s.stream, retryAt: s.streamRetryAt, catchingUp: s.catchingUp },
    canStop,
    stopHint: STOP_HINT,
  };
}
