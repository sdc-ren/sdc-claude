---
name: migrate
description: Move old flat worktrees (<slug>-<repo>) into the one-folder-per-task layout .worktrees/<TASK-ID>/<repo>/.
disable-model-invocation: true
---

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs migrate-worktrees <cwd>` (dry run), show the moves, and only after the user's yes run it again with `--apply`. Report moved, skipped, and ledgers rewritten.

`<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).
