---
name: legacy
description: Fold old suffixed task folders/worktrees (-e2e, -qc, -r2…) into the one-folder-per-ticket layout.
disable-model-invocation: true
---

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs legacy <cwd>` (dry run) and show the plan. Only after the user's yes, run it with `--apply`. Folders whose resources cannot be freed yet are kept and reported.

`<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).
