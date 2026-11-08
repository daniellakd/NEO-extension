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
exports.commandTable = commandTable;
exports.registerCommands = registerCommands;
const vscode = __importStar(require("vscode"));
const chatViewProvider_1 = require("./chatViewProvider");
const focusChat = () => vscode.commands.executeCommand(`${chatViewProvider_1.ChatViewProvider.viewId}.focus`);
function commandTable(provider) {
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
function registerCommands(provider) {
    return Object.entries(commandTable(provider)).map(([id, run]) => vscode.commands.registerCommand(id, run));
}
//# sourceMappingURL=commands.js.map