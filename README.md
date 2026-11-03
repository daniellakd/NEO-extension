# NEO for VS Code

A NEO chat sidebar for VS Code. The extension is a client of the existing NEO backend: projects,
phases, gates, checks and the whole pipeline run in NEO exactly as they do from the NEO web UI.

## Requirements

- VS Code 1.90 or later
- Node.js 18 or later, with npm
- A NEO installation. By default NEO runs at `http://127.0.0.1:8720`.

## Install and build

```bash
cd vscode-neo
npm install
npm run compile
```

## Start NEO

The extension does not start NEO; start it first, from the NEO folder.

Windows:

```powershell
.\scripts\start.ps1
```

Linux:

```bash
./scripts/start.sh
```

If NEO runs at a different address, set **`neo.serverUrl`** in VS Code settings.

## Run the extension

1. Open the `vscode-neo` folder in VS Code.
2. Open **Run and Debug**, select **Run NEO Extension**, and press **Start** (F5).
3. In the new VS Code window, open your project folder (**File → Open Folder**).
4. Click the **NEO** icon in the Activity Bar.

The sidebar shows **Connected** when NEO is reachable. If it is not, start NEO and click
**Retry**.

## Using the sidebar

- **Chat:** type in the message box and press **Send** (or Ctrl+Enter).
- **Questions:** click one of the offered options, or type your own answer.
- **Phase:** the pipeline row under the header shows where the project is; the chip under the
  message box repeats the current phase and says whether NEO is working or waiting on you.
- **Gates:** when NEO reaches a gate, a card shows the document and its checks, with **Approve**
  and **Request Changes**.
- **Header actions:** **Projects** (switches the sidebar to another NEO project), **New Project**
  and **Web UI** (opens the NEO web UI on the current project).

Commands are also available from the Command Palette: `NEO: Connect`, `NEO: Refresh`,
`NEO: New Project`, `NEO: Projects` and `NEO: Open in Browser`.

## Adding context to a message

You can attach workspace files to a message, so NEO sees exactly the code you mean:

- **+** under the message box: **Current file**, **Current selection** or **Choose file…**
- **@** typed at the start of the message or after a space: opens **Choose file…**
- The dashed chip above the message box offers the file (or selected lines) you are in; click it
  to attach.
- In the editor, right-click a selection → **NEO: Add Selection to Message**. The Command Palette
  also has `NEO: Add Context to Message…` and `NEO: Add Current File to Message`.

Attached items are shown as chips above the message box; **×** removes one. Nothing is attached
unless you attach it. A selection is captured when you attach it; a whole file is read when you
press Send, including unsaved edits.

The context is added to the end of your message, after your own text, so NEO's pipeline handles
it like any other message. In the chat, your message shows the chips, and **Show attached context**
expands what was sent.

Limits: 5 items per message, 40,000 characters per item and 80,000 in total. Binary files cannot
be attached.

## Existing project or new project

**Existing project:** if the open folder is already a NEO project, the sidebar selects it
automatically and shows its history, current phase and any open gate.

**New project:** if the folder is not a NEO project, the sidebar says so and offers **New
Project**, **Projects** and **Open Web UI**. Enter the project name and what you want built; NEO
then starts its normal pipeline from Brainstorm.

NEO creates new projects inside its projects folder. To create one in the folder you have open:

1. Use an **empty** folder, for example `C:\neo-demo\todo-api`.
2. Start NEO with that folder's parent as its projects folder:

   ```powershell
   $env:NEOAG_PROJECTS_ROOT='C:\neo-demo'; .\scripts\start.ps1
   ```

   ```bash
   NEOAG_PROJECTS_ROOT=~/neo-demo ./scripts/start.sh
   ```

3. Use the folder's name as the project name (`todo-api`).

---

<sub>NEO · Powered by CodeValue</sub>
