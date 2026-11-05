import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";

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
    vscode.commands.registerCommand("neo.connect", () => provider.connect()),
    vscode.commands.registerCommand("neo.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("neo.newProject", async () => {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
      provider.showNewProject();
    }),
    vscode.commands.registerCommand("neo.openInBrowser", () => provider.openInBrowser()),
    vscode.commands.registerCommand("neo.switchProject", () => provider.switchProject()),
    // The open project's sessions; one picked opens read-only and the active session is unchanged.
    vscode.commands.registerCommand("neo.sessions", () => provider.showSessions()),
    // Context for the next message. Each reveals the chat, where the chip it made is shown.
    ...(
      [
        ["neo.addContext", "menu"],
        ["neo.addCurrentFile", "file"],
        ["neo.addSelection", "selection"],
      ] as const
    ).map(([id, source]) =>
      vscode.commands.registerCommand(id, async () => {
        await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
        await provider.addContext(source);
      }),
    ),
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
