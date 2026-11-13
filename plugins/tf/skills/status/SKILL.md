---
name: status
description: Show what every tf task holds (worktrees, DBs, ports, PRs) and what the reaper would free now.
disable-model-invocation: true
---

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs list` and `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs reap --dry-run`; summarize per task.

`<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).
