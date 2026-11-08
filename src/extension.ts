import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";
import { registerCommands } from "./commands";

/**
 * NEO: a sidebar chat over the local NEO-AG orchestrator. The extension never starts NEO and
 * never runs any part of its pipeline; it reads NEO's state and forwards the user's actions.
 */
export function activate(context: vscode.ExtensionContext): void {
  // `globalState` remembers each project's plan, so "Task 3 of 8 · Implement CRUD routes" is
  // still there after a window reload in the middle of Execute.
  const provider = new ChatViewProvider(context.extensionUri, context.globalState);

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      // The transcript is rebuilt from the host on reload, but keeping it alive avoids a redraw —
      // and losing a half-typed gate reason — every time the sidebar is switched away from.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Every NEO command (src/commands.ts); the view title shows some of them by state.
    ...registerCommands(provider),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("neo.serverUrl")) void provider.connect();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void provider.connect()),
  );

  void provider.connect();
}

export function deactivate(): void {
  // Disposables registered above stop the stream and the resync timer.
}
