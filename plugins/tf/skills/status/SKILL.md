---
name: status
description: What the tf tasks of this workspace hold (worktrees, DBs, ports, PRs) and what cleanup would free; with --doctor, also check that this machine and workspace can run tf.
argument-hint: "[--doctor]"
disable-model-invocation: true
---

Input: `$ARGUMENTS`. `<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs list` and
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs reap --dry-run`: one short table per task — what it holds,
   its PRs, what the reaper would free now.
2. With `--doctor` (or when the user asks whether the setup works):
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs <cwd>` — what passed, what failed, how to fix each failure.

Reply in the user's language.
