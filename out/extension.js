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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const chatViewProvider_1 = require("./chatViewProvider");
/**
 * NEO: a sidebar chat over the local NEO-AG orchestrator. The extension never starts NEO and
 * never runs any part of its pipeline; it reads NEO's state and forwards the user's actions.
 */
function activate(context) {
    // `globalState` remembers each project's plan, so "Task 3 of 8 · Implement CRUD routes" is
    // still there after a window reload in the middle of Execute.
    const provider = new chatViewProvider_1.ChatViewProvider(context.extensionUri, context.globalState);
    context.subscriptions.push(provider, vscode.window.registerWebviewViewProvider(chatViewProvider_1.ChatViewProvider.viewId, provider, {
        // The transcript is rebuilt from the host on reload, but keeping it alive avoids a redraw —
        // and losing a half-typed gate reason — every time the sidebar is switched away from.
        webviewOptions: { retainContextWhenHidden: true },
    }), vscode.commands.registerCommand("neo.connect", () => provider.connect()), vscode.commands.registerCommand("neo.refresh", () => provider.refresh()), vscode.commands.registerCommand("neo.newProject", async () => {
        await vscode.commands.executeCommand(`${chatViewProvider_1.ChatViewProvider.viewId}.focus`);
        provider.showNewProject();
    }), vscode.commands.registerCommand("neo.openInBrowser", () => provider.openInBrowser()), vscode.commands.registerCommand("neo.switchProject", () => provider.switchProject()), 
    // The open project's sessions; one picked opens read-only and the active session is unchanged.
    vscode.commands.registerCommand("neo.sessions", () => provider.showSessions()), 
    // Context for the next message. Each reveals the chat, where the chip it made is shown.
    ...[
        ["neo.addContext", "menu"],
        ["neo.addCurrentFile", "file"],
        ["neo.addSelection", "selection"],
    ].map(([id, source]) => vscode.commands.registerCommand(id, async () => {
        await vscode.commands.executeCommand(`${chatViewProvider_1.ChatViewProvider.viewId}.focus`);
        await provider.addContext(source);
    })), vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("neo.serverUrl"))
            void provider.connect();
    }), vscode.workspace.onDidChangeWorkspaceFolders(() => void provider.connect()));
    void provider.connect();
}
function deactivate() {
    // Disposables registered above stop the stream and the resync timer.
}
//# sourceMappingURL=extension.js.map