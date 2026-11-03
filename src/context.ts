import * as path from "path";
import * as vscode from "vscode";

/**
 * Workspace context the user attaches to a message: a file, or a range of lines in one.
 *
 * NEO has no field for this, and needs none: an attachment travels inside the message text, after
 * the user's own words, under a marker line the webview recognises to fold it away again. Nothing
 * is attached unless the user attached it, and nothing but what is listed is ever read.
 */

export const MAX_ITEMS = 5;
export const MAX_ITEM_CHARS = 40_000;
// NEO's /message and /start take at most 100,000 characters; the rest is left for the message.
export const MAX_TOTAL_CHARS = 80_000;

// chat.js looks for exactly this line; change both together.
const MARKER = "--- Attached from VS Code ---";

// Never offered by "Choose file": generated, vendored or VCS content nobody means to attach.
const PICKER_EXCLUDE =
  "**/{node_modules,.git,.venv,venv,__pycache__,.pytest_cache,.mypy_cache,dist,out,build,.worktrees,.neoag}/**";

export class ContextError extends Error {}

export interface Attachment {
  id: string;
  kind: "file" | "selection";
  uri: vscode.Uri;
  path: string;                   // as shown and sent: relative to the workspace folder
  lines?: [number, number];       // 1-based, inclusive
  text?: string;                  // a selection is a snapshot; a file is read again at send time
  language: string;
  chars: number;
}

/** What the webview draws for an attachment. */
export interface AttachmentView {
  id: string;
  kind: Attachment["kind"];
  label: string;
  detail: string;
}

let counter = 0;

function linesText(lines: Attachment["lines"]): string {
  if (!lines) return "";
  return lines[0] === lines[1] ? ` · line ${lines[0]}` : ` · lines ${lines[0]}–${lines[1]}`;
}

export function labelOf(a: Pick<Attachment, "path" | "lines">): string {
  return path.basename(a.path) + linesText(a.lines);
}

export function viewOf(a: Attachment): AttachmentView {
  const what = a.kind === "selection" ? "selected lines, captured when attached" : "whole file, read when you send";
  return { id: a.id, kind: a.kind, label: labelOf(a), detail: `${a.path} · ${what} · ${a.chars.toLocaleString()} chars` };
}

/** Same file and same lines: attaching it twice would only send it twice. */
export function sameTarget(a: Attachment, b: Pick<Attachment, "uri" | "lines">): boolean {
  return a.uri.toString() === b.uri.toString() && String(a.lines) === String(b.lines);
}

function relPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

function languageOf(uri: vscode.Uri): string {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  return open ? open.languageId : path.extname(uri.fsPath).replace(/^\./, "");
}

function tooLarge(what: string, chars: number): ContextError {
  return new ContextError(
    `${what} is ${chars.toLocaleString()} characters; one attachment may be at most ` +
      `${MAX_ITEM_CHARS.toLocaleString()}. Select the relevant lines and attach the selection instead.`,
  );
}

/**
 * A file's text as the user sees it: the open editor's buffer, unsaved edits included, or the file
 * on disk. Refuses binary content and anything over the per-item limit before decoding it.
 */
async function readText(uri: vscode.Uri): Promise<string> {
  const name = path.basename(uri.fsPath);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    const text = open.getText();
    if (text.includes("\u0000")) throw new ContextError(`${name} looks like a binary file; only text can be attached.`);
    if (text.length > MAX_ITEM_CHARS) throw tooLarge(name, text.length);
    return text;
  }
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    throw new ContextError(`${name} could not be read: it may have been moved or deleted.`);
  }
  if (stat.type & vscode.FileType.Directory) throw new ContextError(`${name} is a folder; attach a file.`);
  // A UTF-8 character is at most 4 bytes, so a file this big cannot be within the limit.
  if (stat.size > MAX_ITEM_CHARS * 4) throw tooLarge(name, stat.size);
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.subarray(0, 8000).includes(0)) {
    throw new ContextError(`${name} looks like a binary file; only text can be attached.`);
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (text.length > MAX_ITEM_CHARS) throw tooLarge(name, text.length);
  return text;
}

export async function fileAttachment(uri: vscode.Uri): Promise<Attachment> {
  if (uri.scheme !== "file") throw new ContextError("Only files saved on disk can be attached.");
  const text = await readText(uri);
  return { id: `ctx${++counter}`, kind: "file", uri, path: relPath(uri), language: languageOf(uri), chars: text.length };
}

/**
 * The lines a selection covers, 1-based and inclusive. A selection ending at the very start of a
 * line (as a triple-click or a drag to the margin leaves it) does not include that line.
 */
export function selectedLines(sel: vscode.Selection): [number, number] {
  const first = sel.start.line;
  const last = sel.end.character === 0 && sel.end.line > first ? sel.end.line - 1 : sel.end.line;
  return [first + 1, last + 1];
}

/** The selected lines, whole lines, captured now. */
export function selectionAttachment(editor: vscode.TextEditor): Attachment {
  const doc = editor.document;
  const sel = editor.selection;
  if (doc.uri.scheme !== "file") throw new ContextError("Only files saved on disk can be attached.");
  if (sel.isEmpty) throw new ContextError("Nothing is selected. Select some lines first.");
  const [first, last] = selectedLines(sel);
  const text = doc.getText(new vscode.Range(first - 1, 0, last - 1, doc.lineAt(last - 1).text.length));
  const a: Attachment = {
    id: `ctx${++counter}`,
    kind: "selection",
    uri: doc.uri,
    path: relPath(doc.uri),
    lines: [first, last],
    text,
    language: doc.languageId,
    chars: text.length,
  };
  if (text.length > MAX_ITEM_CHARS) throw tooLarge(labelOf(a), text.length);
  return a;
}

/** A fence no line of the content can close: longer than any backtick run inside it. */
function fence(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The message NEO receives: the user's words untouched, then each attachment under the marker.
 * Files are read now, so NEO sees what the user sees at the moment of sending.
 */
export async function composeMessage(text: string, attachments: Attachment[]): Promise<string> {
  if (!attachments.length) return text;
  const blocks: string[] = [];
  let total = 0;
  for (const a of attachments) {
    const content = a.kind === "selection" ? a.text ?? "" : await readText(a.uri);
    total += content.length;
    if (total > MAX_TOTAL_CHARS) {
      throw new ContextError(
        `The attachments add up to more than ${MAX_TOTAL_CHARS.toLocaleString()} characters. ` +
          "Remove one, or attach a selection instead of a whole file.",
      );
    }
    const f = fence(content);
    blocks.push(`File: ${a.path}${linesText(a.lines)}\n${f}${a.language}\n${content.replace(/\n$/, "")}\n${f}`);
  }
  return (
    `${text}\n\n${MARKER}\n` +
    "Read-only snapshots the user attached, taken when this message was sent. Paths are relative " +
    "to the workspace folder.\n\n" +
    blocks.join("\n\n")
  );
}

/** "Choose file": a quick pick over the workspace's files, like Go to File. */
export async function pickWorkspaceFile(): Promise<vscode.Uri | undefined> {
  type Item = vscode.QuickPickItem & { uri: vscode.Uri };
  const pick = vscode.window.createQuickPick<Item>();
  pick.title = "Attach a file to your NEO message";
  pick.placeholder = "Type to search the workspace's files";
  pick.matchOnDescription = true;
  pick.busy = true;
  pick.show();
  const files = await vscode.workspace.findFiles("**/*", PICKER_EXCLUDE, 5000);
  pick.items = files
    .map((uri) => {
      const rel = relPath(uri);
      const dir = path.dirname(rel);
      return { uri, label: path.basename(rel), description: dir === "." ? "" : dir };
    })
    .sort((a, b) => (a.description + a.label).localeCompare(b.description + b.label));
  pick.busy = false;
  return new Promise((resolve) => {
    pick.onDidAccept(() => {
      resolve(pick.selectedItems[0]?.uri);
      pick.hide();
    });
    pick.onDidHide(() => {
      resolve(undefined);
      pick.dispose();
    });
  });
}
