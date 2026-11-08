import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";

/**
 * Every NEO command, in one table: what package.json contributes is what is registered here
 * (src/test/commands.test.ts checks the two agree). Each entry is a thin call into the sidebar,
 * which owns the behaviour and says why when a command cannot act right now.
 */

/** The provider surface the commands use. */
export type CommandHost = Pick<
  ChatViewProvider,
  | "connect"
  | "refresh"
  | "showNewProject"
  | "openInBrowser"
  | "switchProject"
  | "showSessions"
  | "startSession"
  | "addContext"
  | "stopCurrentWork"
  | "openDocument"
  | "openChanges"
  | "goTo"
>;

const focusChat = () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);

export function commandTable(provider: CommandHost): Record<string, () => unknown> {
  return {
    "neo.connect": () => provider.connect(),
    "neo.refresh": () => provider.refresh(),
    "neo.newProject": async () => {
      await focusChat();
      provider.showNewProject();
    },
    "neo.openInBrowser": () => provider.openInBrowser(),
    "neo.switchProject": () => provider.switchProject(),
    // The open project's sessions; one picked opens read-only and the active session is unchanged.
    "neo.sessions": () => provider.showSessions(),
    // New work on the open project once its current session is complete (NEO's POST /sessions).
    "neo.startSession": async () => {
      await focusChat();
      await provider.startSession();
    },
    // NEO's own abort, as the chat's Stop button sends it.
    "neo.stop": () => provider.stopCurrentWork(),
    // The current session's documents, changes and places: read-only, nothing is switched.
    "neo.openDesign": () => provider.openDocument("design"),
    "neo.openPlan": () => provider.openDocument("plan"),
    "neo.openChanges": () => provider.openChanges(),
    "neo.goTo": () => provider.goTo(),
    "neo.openSettings": () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:neoag.neo-vscode"),
    // Context for the next message. Each reveals the chat, where the chip it made is shown.
    "neo.addContext": async () => {
      await focusChat();
      await provider.addContext("menu");
    },
    "neo.addCurrentFile": async () => {
      await focusChat();
      await provider.addContext("file");
    },
    "neo.addSelection": async () => {
      await focusChat();
      await provider.addContext("selection");
    },
  };
}

export function registerCommands(provider: CommandHost): vscode.Disposable[] {
  return Object.entries(commandTable(provider)).map(([id, run]) => vscode.commands.registerCommand(id, run));
}
