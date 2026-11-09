import * as path from "path";
import * as vscode from "vscode";
import type { Project } from "./neoClient";

/** The folder this window is about: the first workspace folder, if it is on disk. */
export function currentFolder(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && folder.uri.scheme === "file" ? folder.uri.fsPath : undefined;
}

/**
 * A path in a form two spellings of the same folder agree on.
 *
 * VS Code reports `c:\Users\...` and NEO stores `C:\Users\...` (Python's resolve()), so on Windows
 * the comparison ignores case and separator style. Elsewhere paths are case-sensitive and compared
 * as they are.
 */
export function normalizePath(p: string, platform: NodeJS.Platform = process.platform): string {
  const windows = platform === "win32";
  let out = (windows ? path.win32 : path.posix).normalize(p);
  if (windows) out = out.replace(/\//g, "\\");
  out = out.replace(/[\\/]+$/, "");
  return windows ? out.toLowerCase() : out;
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/** Whether `file` is `folder` itself or somewhere inside it. */
export function insidePath(file: string, folder: string): boolean {
  const f = normalizePath(file);
  const d = normalizePath(folder);
  return f === d || f.startsWith(d + (process.platform === "win32" ? "\\" : "/"));
}

/** The registered project that lives in this folder, if any. Archived projects are not listed. */
export function projectForFolder(projects: Project[], folder: string): Project | undefined {
  return projects.find((p) => samePath(p.path, folder));
}

/**
 * The name NEO's `create_workspace` would turn a project name into (projects.py `slugify`). The
 * demo relies on it landing on the open folder, so the form warns when it would not.
 */
export function neoSlug(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").toLowerCase();
}
