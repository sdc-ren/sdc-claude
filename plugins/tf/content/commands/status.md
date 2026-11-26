---
name: status
description: What the tf tasks of this workspace hold (worktrees, DBs, ports, PRs) and what cleanup would free; with --doctor, also check that this machine and workspace can run tf; with --metrics, what the runs cost (time per role, re-tests, tokens).
args: "[--doctor] [--metrics [slug]]"
user-only: true
---

{{fallback}}

Input: `{{args}}`. `<cwd>` is the workspace root (the folder that holds `{{config}}`).

1. `node {{root}}/scripts/resources.mjs list --table <cwd>` — show the table as it prints (one row per
   task: PRs, what it holds, disk, whether `/tf:clean` frees it now) and its last lines (totals, ⚠ an id two tasks
   hold at once). Do not add paths or commands; `resources.mjs list <cwd>` has them when the user asks for one task.
2. With `--doctor` (or when the user asks whether the setup works):
   `node {{root}}/scripts/doctor.mjs <cwd>` — what passed, what failed, how to fix each failure.
3. With `--metrics`: `node {{root}}/scripts/metrics.mjs <cwd> --all` (one line per run of the last
   30 days, with the plugin version), or with a slug `node {{root}}/scripts/metrics.mjs <cwd> <slug>`
   (every job: minutes, time in tools vs model, slowest commands). Show the table, then say in two or three
   lines where the time went (which role, which jobs, how many re-tests) — numbers only, no guesses about causes
   the output does not show. Steps 1–2 are skipped when only `--metrics` is given.

Reply in the user's language.
