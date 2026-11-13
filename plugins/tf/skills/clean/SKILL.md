---
name: clean
description: Clean up tf state, always as a dry run first and applied only after the user's yes — free one task (<slug>), move old flat worktrees into .worktrees/<TICKET>/<repo>/ (--migrate), or fold old suffixed task folders into one folder per ticket (--legacy).
argument-hint: "<slug> | --migrate | --legacy"
disable-model-invocation: true
---

Input: `$ARGUMENTS`. `<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).
Every action: show the plan, then act only after a clear yes from the user.

- `<slug>` — free one task: show what `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs list` says it holds;
  on yes `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs release <cwd> <slug>` then
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs archive <cwd> <slug>`. Worktrees with uncommitted or
  unpushed work are kept — report them.
- `--migrate` — `node ${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs migrate-worktrees <cwd>` (dry run); on yes the same
  with `--apply`. Report moved, skipped, ledgers rewritten.
- `--legacy` — `node ${CLAUDE_PLUGIN_ROOT}/scripts/task.mjs legacy <cwd>` (dry run); on yes the same with
  `--apply`. Folders whose resources cannot be freed yet are kept and reported.
- Nothing given → run `--migrate` and `--legacy` as dry runs and `resources.mjs reap --dry-run`, and say
  what each would do.

Reply in the user's language.
