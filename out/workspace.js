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
exports.currentFolder = currentFolder;
exports.normalizePath = normalizePath;
exports.samePath = samePath;
exports.projectForFolder = projectForFolder;
exports.neoSlug = neoSlug;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
/** The folder this window is about: the first workspace folder, if it is on disk. */
function currentFolder() {
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
function normalizePath(p, platform = process.platform) {
    const windows = platform === "win32";
    let out = (windows ? path.win32 : path.posix).normalize(p);
    if (windows)
        out = out.replace(/\//g, "\\");
    out = out.replace(/[\\/]+$/, "");
    return windows ? out.toLowerCase() : out;
}
function samePath(a, b) {
    return normalizePath(a) === normalizePath(b);
}
/** The registered project that lives in this folder, if any. Archived projects are not listed. */
function projectForFolder(projects, folder) {
    return projects.find((p) => samePath(p.path, folder));
}
/**
 * The name NEO's `create_workspace` would turn a project name into (projects.py `slugify`). The
 * demo relies on it landing on the open folder, so the form warns when it would not.
 */
function neoSlug(name) {
    return name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").toLowerCase();
}
//# sourceMappingURL=workspace.js.map