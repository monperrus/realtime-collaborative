# Collaborative Real-Time Editor — Architecture

## Overview

A split-process collaborative editor: a local CLI watches a folder on disk, and any number of browsers can view and edit the files in real time via a public relay server. Changes sync bidirectionally between disk and browser using CRDTs (Yjs).

```
  Local machine                         Dokku (rootmab)
  ────────────────────────────          ─────────────────────────────────
  ~/bin/collab-folder                   https://collab.gakoy.com
        │
        ▼
  watcher.js
  ├── chokidar (file watch)
  ├── control WS ──────────────────────▶ relay/server.js  ──▶ SSE ──▶ browser
  │     /__watcher__?token=T                │                           (file tree)
  │                                         │
  └── HocuspocusProvider (per file) ──────▶ Hocuspocus ◀──── HocuspocusProvider
        wss://relay/T/filename              (Yjs hub)          (browser, per file)
```

## Components

### `relay/server.js` — relay server (Dokku, always-on)

- **Express** serves the static web UI (`public/index.html`, `public/bundle.js`).
- **Hocuspocus** (`@hocuspocus/server`) is the Yjs WebSocket hub. It stores live CRDT state for open documents in memory. Document names are namespaced as `<token>/<filepath>` so multiple sessions never share state.
- **Control plane WebSocket server** (`/__watcher__?token=T`) accepts one connection per session from the local watcher. Receives file-tree updates and forwards `{type:'open', name}` signals when a browser opens a file.
- **SSE endpoint** (`/api/watch?token=T`) pushes live file-tree JSON to browsers whenever the watcher reports a change.
- **Session map** (`Map<token, {ws, requestedDocs, sseClients, fileTree}>`) isolates all per-session state. A session is created when the watcher connects and deleted when it disconnects. WebSocket upgrades for unknown tokens are rejected with 403.

### `watcher.js` — local watcher (runs on user's machine)

This repo's `watcher.js` is the original watcher. The one users run is the
published CLI `@gakoy/collab`, maintained in
[monperrus/collab](https://github.com/monperrus/collab), which has since
replaced the echo-suppression window with content comparison and merges disk
edits into the document instead of replacing it.

- Generates a random 32-hex-char **token** on startup and prints the full session URL.
- Opens a **control WebSocket** to `/__watcher__?token=T`. On connect, sends the full file tree. Reconnects automatically on disconnect.
- Watches the folder with **chokidar** (ignores dotfiles, `node_modules`, permission errors). On any add/remove, re-sends the file tree over the control WS.
- On receiving `{type:'open', name}` from the relay, calls `ensureConnected(docName)`:
  - Creates a Yjs `Y.Doc` and opens a **HocuspocusProvider** to `wss://relay/T/docName`.
  - On first sync (`onSynced`): if the Yjs doc is empty, pushes the file content into it. Then observes the Yjs text and writes changes back to disk (debounced 300 ms, with a 2 s echo-suppression guard).
- On local file change (chokidar `change` event): if a HocuspocusProvider is open for that file and the change wasn't self-inflicted, replaces the full Yjs text in a single transaction.

### `relay/src/client.js` → `relay/public/bundle.js` — browser client

Built with **esbuild** into a single `bundle.js` loaded by `index.html`.

- Reads `?token=T` from the URL. Shows an error if absent.
- **SSE** (`/api/watch?token=T`): receives file-tree updates and renders a collapsible tree sidebar.
- On file click, opens a **HocuspocusProvider** to `wss://host/T/filepath` with `name: T/filepath`. The token in the name ensures the browser and watcher join the same Hocuspocus document.
- **CodeMirror 6** editor (`basicSetup` minus its undo history + `oneDark` theme + language extensions + `EditorView.lineWrapping`) is bound to the Yjs text via `y-codemirror.next`.
- **Undo** is the Yjs `UndoManager`, which tracks the local user's edits only. CodeMirror's own history also recorded remote changes and the initial load of the file, so repeated Ctrl-Z emptied the document, and the watcher then emptied the file on disk.
- **Awareness** (cursor/presence) is wired through the provider; each browser tab gets a random color and username.

### `~/bin/collab-folder` — CLI entry point

A shell wrapper around the published CLI: `exec npx --yes @gakoy/collab@latest "$@"`.

## Wire protocols

| Path | Protocol | Purpose |
|---|---|---|
| `/__watcher__?token=T` | WebSocket (JSON) | Control plane: file tree, open-file signals |
| `/<token>/<filepath>` | WebSocket (Hocuspocus) | Yjs CRDT sync (browser ↔ relay ↔ watcher) |
| `/api/watch?token=T` | SSE | Live file tree push to browsers |
| `/api/files?token=T` | HTTP GET (JSON) | File tree snapshot (unused by current client) |
| `/*` | HTTP | Static assets (no token required) |

## Key dependency: Hocuspocus wire protocol

Hocuspocus uses its own WebSocket protocol (not the standard `y-websocket` protocol): every message is prefixed with the document name as a varstring. Both the browser and the watcher must use `@hocuspocus/provider` (`HocuspocusProvider`). Using `y-websocket`'s `WebsocketProvider` causes silent message drops on the relay side.

## Session lifecycle

1. `collab-folder ./mydir` → watcher generates token, connects control WS, sends file tree.
2. User opens `https://collab.gakoy.com/?token=T` → browser subscribes to SSE, renders file tree.
3. User clicks a file → browser opens HocuspocusProvider for `T/filename` → relay fires `onLoadDocument` → signals watcher via control WS → watcher opens HocuspocusProvider for same doc → pushes disk content → browser receives it and renders in CodeMirror.
4. Browser edits → Yjs CRDT update → relay → watcher → debounced disk write.
5. Disk edit → chokidar → watcher replaces Yjs text → relay → browser CodeMirror updates.
6. Watcher disconnects (Ctrl-C) → relay deletes session → token no longer valid.

## Deployment

- Relay: Dokku app `collab` on `rootmab`, domain `collab.gakoy.com`, TLS via Let's Encrypt.
- Deploy: `cd relay && git push dokku main` (Dockerfile multi-stage build: esbuild bundle in build stage, production image only has runtime deps + pre-built `public/`).
- Watcher: the npm package `@gakoy/collab`, run through `~/bin/collab-folder` (in `$PATH`) or `npx @gakoy/collab`.
