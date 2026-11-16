# Changelog

## 0.2.0 — first installable preview

A preview build for use with NEO-AG Cross-Platform. It is not published to the VS Code Marketplace; install the `.vsix` with **Extensions: Install from VSIX…**.

- The default `neo.serverUrl` is now `http://127.0.0.1:8000`, NEO-AG's default port. Earlier builds defaulted to `8720`. A URL you have set yourself is still used as it is.
- A new Full-pipeline session no longer shows the previous session's plan progress or current task while its own plan is being made.
- The compiled output now matches the source, including `out/errors.js`, which the sidebar needs at runtime.
- Packaging: `npm run package` builds the `.vsix`; `npm run package:ls` lists what goes into it.

Tested on Windows against NEO-AG Cross-Platform in Mock mode, in a real VS Code Extension Development Host and as an installed `.vsix`. Not yet tested with a real agent.

## 0.1.0

Initial version: chat with a local NEO server from the VS Code sidebar: projects, gates, live progress, sessions and changes.
