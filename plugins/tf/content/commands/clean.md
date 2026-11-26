---
name: clean
description: Clean up tf state, always as a dry run first and applied only after the user's yes — free every task whose PRs are all merged or closed (no argument), free one task (<slug>), move old flat worktrees into .worktrees/<TICKET>/<repo>/ (--migrate), or fold old suffixed task folders into one folder per ticket (--legacy).
args: "[<slug> | --migrate | --legacy]"
user-only: true
---

{{fallback}}

Input: `{{args}}`. `<cwd>` is the workspace root (the folder that holds `{{config}}`).
Every action: show the plan, then act only after a clear yes from the user.

- `<slug>` — free one task: show what `node {{root}}/scripts/resources.mjs list` says it holds;
  on yes `node {{root}}/scripts/resources.mjs release <cwd> <slug>` then
  `node {{root}}/scripts/resources.mjs archive <cwd> <slug>`. Worktrees with uncommitted or
  unpushed work are kept — report them.
- `--migrate` — `node {{root}}/scripts/task.mjs migrate-worktrees <cwd>` (dry run); on yes the same
  with `--apply`. Report moved, skipped, ledgers rewritten.
- `--legacy` — `node {{root}}/scripts/task.mjs legacy <cwd>` (dry run); on yes the same with
  `--apply`. Folders whose resources cannot be freed yet are kept and reported.
- Nothing given → the workspace cleanup. Task runs never clean up after other tasks; this is where it happens.
  `node {{root}}/scripts/resources.mjs reap --dry-run <cwd>`: list the tasks whose PRs are all
  merged or closed and the idle ones it would free. On yes the same without `--dry-run` — it frees their
  worktrees, DBs, caches and ports, promotes their passing flows to `_regression/` and archives their
  folders. The dry run prints, per resource, what freeing it will do — show those lines as they are. Report in
  one line each what was kept and why (uncommitted or unpushed work, a release that failed).
  A line marked `NOT a recipe of this workspace's config` is a command tf will not run on its own: quote it
  to the user in full, and only on their yes for that command run
  `node {{root}}/scripts/resources.mjs release <cwd> <slug> --unlisted`.
  Also run `--migrate` and `--legacy` as dry runs and mention them only when they have something to do.

Reply in the user's language.
