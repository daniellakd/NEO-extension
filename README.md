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
- **Header actions** (the icons at the top of the sidebar; they follow the project's state):
  - **Stop Current Work** - only while NEO is running something.
  - **Start New Session** - only when the current session is Done.
  - **Sessions** - when a project is open. **New Project** - when none is.
  - **Projects** - always: switches the sidebar to another NEO project.
  - The **…** menu has the rest: Go to…, Open Design, Open Plan, Open Current Changes, Refresh,
    Open Web UI, New Project, Connect and Open Settings.

## Commands

Every action is in the Command Palette (Ctrl+Shift+P, type `NEO`). Each one acts on the project
shown in the sidebar and its **current** session; when it cannot act right now (no project, nothing
running, no plan in this session…) it says why.

| Command | What it does |
| --- | --- |
| `NEO: Go to…` | One list of where you can go now: the current session (the chat), Design, Plan, Changes, Sessions - each with where it stands (`Plan · task 3 of 8`, `Changes · 4 files`). |
| `NEO: Open Design` / `NEO: Open Plan` | The current session's document, as the chip's **Preview** opens it (read-only Markdown preview). A Quick change session has neither. |
| `NEO: Open Current Changes` | The files the **Changes** strip lists; pick one to open its read-only diff. From Execute on. |
| `NEO: Stop Current Work` | The chat's **Stop**: NEO's own abort of the running turn. Says so when nothing is running. |
| `NEO: Sessions` | Every session of the project; one picked opens as a read-only snapshot. |
| `NEO: Start New Session` | New work once the current session is Done (Full pipeline, Quick plan or Quick change). |
| `NEO: Projects` / `NEO: New Project` | Switch the sidebar to another project / create one in the open folder. |
| `NEO: Refresh` / `NEO: Connect` | Re-read the project / reconnect to NEO. |
| `NEO: Open Web UI` | The NEO web UI on the current project. |
| `NEO: Open Settings` | VS Code Settings for this extension (`neo.serverUrl`). |
| `NEO: Add Context to Message…`, `NEO: Add Current File to Message`, `NEO: Add Selection to Message` | See below. |

No keyboard shortcuts are added. To bind one, use **Preferences: Open Keyboard Shortcuts** and
search `NEO` - `NEO: Go to…` and `NEO: Focus on Chat View` are good candidates.

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

## Reviewing what NEO changed

From Execute on, a **Changes** strip above the message box lists the files NEO's work changed,
with additions and deletions (`main.py +24 −3`). Click it to unfold the list; click a file to open
VS Code's diff editor. Both sides of the diff are read-only.

- **While NEO works** (Execute, Review): the work branch's worktree, uncommitted edits included,
  against the point it branched from `main`. Files not yet added to git are marked **U**.
- **At the Review gate:** the same list is inside the gate card, above the checks, so you can open
  each diff before **Approve** or **Request Changes**.
- **After Done:** the merge commit NEO left on `main`, against `main` before the merge.

In the chat, the file name on an edit, write or read row opens that file.

The extension reads git itself (NEO's own `/diff` compares the project root, which stays on `main`
while the work happens in `.worktrees/`). It only runs reading commands and never writes to the
project or the worktree. `git` must be on `PATH`.

## Design and Plan

Under the pipeline row, a small chip for each document NEO writes before Execute shows where it
stands: **Design · approved**, **Plan · awaiting your approval**, **Plan · task 3 of 8**. Hover a
chip for its history (ready, changes requested, approved, with times); click it to unfold the
design's sections or the plan's tasks.

- **At the Design and Plan gates:** the gate card starts with what you are approving - the design's
  sections, or the plan's tasks with their step counts - and changes requested last time, if any.
  The full document is folded below it.
- **During Execute:** the plan's tasks are marked ✓ done, → current and ○ to do. This is the same
  state as the progress line above, so the two always agree.
- **Preview** opens the real `docs/neoag/design.md` or `plan.md` as a read-only Markdown preview
  (during Execute, the worktree's copy, where the plan is ticked). **Open file** opens it in the
  editor. To change a document, use **Request Changes** at its gate, so NEO stays the source of
  truth.

Which documents are shown comes from NEO's own stage list: the gates with a document, up to the
plan's. The Review gate is not affected.

## Sessions and picking up where you left off

A NEO project is worked on in **sessions**: building it is one, a change asked for afterwards is
another. The sidebar always shows the newest one, the **current** session. Each session is
**completed** once it reached Done, **running** while NEO works, **waiting for you** at a question
or a gate, and otherwise **in progress**; an earlier session that NEO replaced before it reached Done
is **ended**.

- **At the top of the chat:** a line names the session the chat shows (**Current session** · title
  · type · when it started). When NEO has more of it than the sidebar loads, it says how many
  earlier events are not shown, with **Open the full session**. A session that starts while the
  sidebar is open gets its own separator in the chat.
- **NEO: Sessions** (the history icon in the view title, or the Command Palette) lists every session
  of the project, newest first: its type, its state (`completed · current`, `completed`, `ended`…),
  when it started and what was asked. Picking one opens it as a **read-only** Markdown preview: the
  request, dates, gate decisions and the stored history. Viewing a session never changes the
  current one, never restarts work and never changes the project; the sidebar stays on the current
  session, so closing the preview is all it takes to return.
- **Starting new work:** once the current session is **completed**, the message box changes: its
  button reads **New session**, and what you send starts a new session on the same project instead
  of going into the finished one. You pick how much of the pipeline it goes through (Full pipeline,
  Quick plan, Quick change - NEO's own choices), NEO starts it, and the sidebar moves to it. The
  completed session stays in **NEO: Sessions** as read-only history. **NEO: Start New Session** in
  the Command Palette, and **Start new session…** at the top of NEO: Sessions, do the same. While a
  session is still in progress, new work waits for it to complete.
- **Since you were away:** the sidebar remembers, per project, the last NEO event you actually had
  on screen (sidebar visible, VS Code focused). When you come back, after reopening VS Code or
  returning to the window, a card lists what NEO stored after it: phases entered, gates reached,
  gate decisions (with the time NEO recorded), questions, messages, stalls, errors, plan steps
  ticked, and sessions started or ended. It also says where things stand now. A **New since your
  last visit** line marks the spot in the chat.

  The card only reports what NEO stored. Stream events carry no time, so no time is given for them.
  If NEO holds more events than can be read, the card says its counts are minimums. The first time
  a project is opened there is no record of a last visit, and the card says that instead of guessing.
  NEO's own automatic messages (auto-continue, repair, approval…) are drawn quieter in the chat than
  yours.

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

## Connection and errors

- **NEO is offline:** the sidebar shows the configured server URL, **Retry** and **Open NEO
  Settings**. Start NEO and press **Retry**; with no project open the sidebar also checks again
  every 10 seconds and connects on its own. Header actions that need NEO stay visible but disabled,
  and their tooltip says why.
- **Connection lost with a project open:** the header says **Reconnecting…** and the project,
  transcript, your typed message and attached files stay as they are. After three failed reads in a
  row (about 30 seconds) the sidebar says **NEO is offline**, and keeps trying in the background.
  When NEO answers again it says **Reconnected to NEO** and catches up on what it missed.
- **Errors** are shown as a short summary, with what to do where it is known. **Show details**
  expands the technical part (HTTP status, NEO's response, the network cause). The same details are
  written to the **NEO** output channel (**View → Output → NEO**).
- **Retry** only repeats reads (reconnect, reload the project, list projects or sessions). Sending a
  message, answering, approving or rejecting a gate, creating a project and starting a session are
  never repeated automatically; the text you typed is kept so you can decide. If NEO may have
  received an action before the connection failed, the sidebar says so: check the transcript before
  sending it again.
- **Settings:** `NEO: Open NEO Settings` (Command Palette, or the sidebar's **…** menu) opens VS
  Code's Settings at **neo.serverUrl**.

---

<sub>NEO · Powered by CodeValue</sub>
