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

  /** Every warning notification shown, with the actions it offered. */
  warnings: { text: string; actions: string[] }[];

  /** Every error notification shown, with the actions it offered. */
  errors: { text: string; actions: string[] }[];

  /** What the "NEO" output channel was given. */
  log: string[];

  /** Commands registered through vscode.commands.registerCommand, by id. */
  registered: Map<string, (...args: unknown[]) => unknown>;

  /** What workspace.findFiles finds (absolute paths): the files "@" can offer. */
  files: string[];
} = {
  folders: [],
  serverUrl: "http://127.0.0.1:0",
  quickPick: null,
  commands: [],
  focused: true,
  inputBox: undefined,
  infos: [],
  warnings: [],
  errors: [],
  log: [],
  registered: new Map(),
  files: [],
};

/**
 * window.createQuickPick, as the workspace file picker drives it: once its listeners are in place,
 * `stubState.quickPick` is asked for the item (undefined: the user pressed Escape).
 */
function createQuickPick() {
  let accepted: (() => void) | undefined;
  let hidden: (() => void) | undefined;
  let open = true;
  const pick = {
    title: "", placeholder: "", matchOnDescription: false, busy: false,
    items: [] as { id?: string }[],
    selectedItems: [] as unknown[],
    show() {},
    hide() {
      if (!open) return;
      open = false;
      hidden?.();
    },
    dispose() {},
    onDidAccept(f: () => void) {
      accepted = f;
      return disposable();
    },
    onDidHide(f: () => void) {
      hidden = f;
      setTimeout(() => {
        const chosen = stubState.quickPick ? stubState.quickPick(pick.items) : undefined;
        if (chosen) {
          pick.selectedItems = [chosen];
          accepted?.();
        } else {
          pick.hide();
        }
      }, 0);
      return disposable();
    },
  };
  return pick;
}

const vscode = {
  Uri,

  FileType: {
    File: 1,
    Directory: 2,
  },

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

    showInformationMessage: async (m: string) => {
      stubState.infos.push(m);
      return undefined;
    },

    showInputBox: async () => stubState.inputBox,

    showWarningMessage: async (text: string, ...actions: string[]) => {
      stubState.warnings.push({ text, actions });
      return undefined;
    },

    showErrorMessage: async (text: string, ...actions: string[]) => {
      stubState.errors.push({ text, actions });
      return undefined;
    },

    createOutputChannel: () => ({
      appendLine: (line: string) => {
        stubState.log.push(line);
      },
      show() {},
      dispose() {},
    }),

    showQuickPick: async (items: { id?: string }[]) =>
      stubState.quickPick ? stubState.quickPick(items) : undefined,

    createQuickPick,

    showTextDocument: async () => undefined,

    registerWebviewViewProvider: disposable,
  },

  workspace: {
    get workspaceFolders() {
      return stubState.folders.map((f) => ({
        uri: Uri.file(f),
        name: path.basename(f),
      }));
    },

    getConfiguration: () => ({
      get: (key: string) =>
        key === "serverUrl" ? stubState.serverUrl : undefined,
    }),

    asRelativePath: (u: Uri | string) =>
      typeof u === "string" ? u : u.fsPath,

    textDocuments: [],

    findFiles: async () => stubState.files.map((f) => Uri.file(f)),

    onDidChangeConfiguration: event(),
    onDidChangeWorkspaceFolders: event(),

    registerTextDocumentContentProvider: disposable,

    fs: {
      readFile: async (u: Uri) => fs.readFileSync(u.fsPath),

      stat: async (u: Uri) => {
        const s = fs.statSync(u.fsPath);
        return {
          type: s.isDirectory() ? 2 : 1,
          size: s.size,
          mtime: s.mtimeMs,
          ctime: s.ctimeMs,
        };
      },

      readDirectory: async (u: Uri) =>
        fs
          .readdirSync(u.fsPath, { withFileTypes: true })
          .map((d) => [d.name, d.isDirectory() ? 2 : 1]),
    },
  },

  commands: {
    registerCommand: (
      id: string,
      run: (...args: unknown[]) => unknown,
    ) => {
      stubState.registered.set(id, run);

      return {
        dispose: () => stubState.registered.delete(id),
      };
    },

    executeCommand: async (id: string, ...args: unknown[]) => {
      stubState.commands.push({ id, args });
      return undefined;
    },
  },

  env: {
    openExternal: async () => true,
  },
};

const Module = require("module");
const load = Module._load;

Module._load = function (
  this: unknown,
  request: string,
  ...rest: unknown[]
) {
  return request === "vscode"
    ? vscode
    : load.call(this, request, ...rest);
};

/** `globalState`, as far as PlanTracker uses it - values go through JSON, as VS Code stores them. */
export class MemoryStore {
  private data = new Map<string, string>();

  keys(): readonly string[] {
    return [...this.data.keys()];
  }

  get<T>(key: string, fallback?: T): T | undefined {
    const raw = this.data.get(key);
    return raw === undefined
      ? fallback
      : (JSON.parse(raw) as T);
  }

  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, JSON.stringify(value));
    }

    return Promise.resolve();
  }
}