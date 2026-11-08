// A stand-in for the VS Code APIs the extension uses - Uri, workspace.fs, a Memento, and the window /
// workspace / commands surface ChatViewProvider touches - on Node's fs, so its tests run under plain
// node. Import it before anything that imports "vscode".
import * as fs from "fs";
import * as path from "path";

class Uri {
  readonly path: string;
  query = "";
  constructor(readonly fsPath: string, readonly scheme = "file") {
    this.path = fsPath.split(path.sep).join("/");
  }
  static file(f: string): Uri {
    return new Uri(path.resolve(f));
  }
  static joinPath(u: Uri, ...parts: string[]): Uri {
    return new Uri(path.join(u.fsPath, ...parts), u.scheme);
  }
  static parse(s: string): Uri {
    return new Uri(s, s.split(":")[0]);
  }
  static from(c: { scheme?: string; path?: string; query?: string }): Uri {
    const u = new Uri(c.path ?? "", c.scheme ?? "file");
    u.query = c.query ?? "";
    return u;
  }
  with(): Uri {
    return this;
  }
  toString(): string {
    return `${this.scheme}:///${this.path}`;
  }
}

const disposable = () => ({ dispose() {} });
const event = () => () => disposable();

/** What a test can set: the open folder, the server URL, and the answer to a quick pick. */
export const stubState: {
  folders: string[];
  serverUrl: string;
  quickPick: ((items: { id?: string }[]) => unknown) | null;
  /** Every executeCommand call, in order. */
  commands: { id: string; args: unknown[] }[];
  /** Whether the VS Code window has focus. */
  focused: boolean;
  /** The answer to an input box (undefined: the user pressed Escape). */
  inputBox: string | undefined;
  /** Every information message shown, in order. */
  infos: string[];
} = { folders: [], serverUrl: "http://127.0.0.1:0", quickPick: null, commands: [], focused: true, inputBox: undefined, infos: [] };

const vscode = {
  Uri,
  FileType: { File: 1, Directory: 2 },
  Disposable: class {
    constructor(private readonly f?: () => void) {}
    dispose(): void {
      this.f?.();
    }
  },
  Selection: class {},
  Range: class {},
  window: {
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: event(),
    onDidChangeTextEditorSelection: event(),
    get state() {
      return { focused: stubState.focused };
    },
    onDidChangeWindowState: event(),
    showInformationMessage: async (m: string) => void stubState.infos.push(m),
    showInputBox: async () => stubState.inputBox,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async (items: { id?: string }[]) => (stubState.quickPick ? stubState.quickPick(items) : undefined),
    showTextDocument: async () => undefined,
    registerWebviewViewProvider: disposable,
  },
  workspace: {
    get workspaceFolders() {
      return stubState.folders.map((f) => ({ uri: Uri.file(f), name: path.basename(f) }));
    },
    getConfiguration: () => ({ get: (key: string) => (key === "serverUrl" ? stubState.serverUrl : undefined) }),
    asRelativePath: (u: Uri | string) => (typeof u === "string" ? u : u.fsPath),
    textDocuments: [],
    findFiles: async () => [],
    onDidChangeConfiguration: event(),
    onDidChangeWorkspaceFolders: event(),
    registerTextDocumentContentProvider: disposable,
    fs: {
      readFile: async (u: Uri) => fs.readFileSync(u.fsPath),
      stat: async (u: Uri) => {
        const s = fs.statSync(u.fsPath);
        return { type: s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
      },
      readDirectory: async (u: Uri) =>
        fs.readdirSync(u.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? 2 : 1]),
    },
  },
  commands: {
    registerCommand: disposable,
    executeCommand: async (id: string, ...args: unknown[]) => {
      stubState.commands.push({ id, args });
      return undefined;
    },
  },
  env: { openExternal: async () => true },
};

const Module = require("module");
const load = Module._load;
Module._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === "vscode" ? vscode : load.call(this, request, ...rest);
};

/** `globalState`, as far as PlanTracker uses it - values go through JSON, as VS Code stores them. */
export class MemoryStore {
  private data = new Map<string, string>();
  keys(): readonly string[] {
    return [...this.data.keys()];
  }
  get<T>(key: string, fallback?: T): T | undefined {
    const raw = this.data.get(key);
    return raw === undefined ? fallback : (JSON.parse(raw) as T);
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, JSON.stringify(value));
    return Promise.resolve();
  }
}
