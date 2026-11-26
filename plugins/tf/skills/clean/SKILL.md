---
name: clean
description: Clean up tf state, always as a dry run first and applied only after the user's yes — free every task whose PRs are all merged or closed (no argument), free one task (<slug>), move old flat worktrees into .worktrees/<TICKET>/<repo>/ (--migrate), or fold old suffixed task folders into one folder per ticket (--legacy).
argument-hint: "[<slug> | --migrate | --legacy]"
disable-model-invocation: true
---

Not in Claude Code? When the plugin root and the input below still read as variables, `<PLUGIN>` is the folder that holds this file's `skills/` folder, the input is what the user wrote with the command, and the host notes are `<PLUGIN>/hosts/<agent>/notes.md` for the agent you run in (`codex`, `copilot`), not the Claude Code ones.

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
- Nothing given → the workspace cleanup. Task runs never clean up after other tasks; this is where it happens.
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs reap --dry-run <cwd>`: list the tasks whose PRs are all
  merged or closed and the idle ones it would free. On yes the same without `--dry-run` — it frees their
  worktrees, DBs, caches and ports, promotes their passing flows to `_regression/` and archives their
  folders. The dry run prints, per resource, what freeing it will do — show those lines as they are. Report in
  one line each what was kept and why (uncommitted or unpushed work, a release that failed).
  A line marked `NOT a recipe of this workspace's config` is a command tf will not run on its own: quote it
  to the user in full, and only on their yes for that command run
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs release <cwd> <slug> --unlisted`.
  Also run `--migrate` and `--legacy` as dry runs and mention them only when they have something to do.

Reply in the user's language.
