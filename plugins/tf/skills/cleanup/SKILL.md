---
name: cleanup
description: Free every resource of one tf task and archive its folder (after confirmation).
argument-hint: "<slug>"
disable-model-invocation: true
---

Show what `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs list` says the task `$ARGUMENTS` holds and ask the user to confirm. Only after a clear yes: `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs release <cwd> <slug>` then `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs archive <cwd> <slug>`. A worktree with uncommitted or unpushed work is kept — report it.

`<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).
