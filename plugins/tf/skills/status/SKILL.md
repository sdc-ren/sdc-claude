---
name: status
description: What the tf tasks of this workspace hold (worktrees, DBs, ports, PRs) and what cleanup would free; with --doctor, also check that this machine and workspace can run tf; with --metrics, what the runs cost (time per role, re-tests, tokens).
argument-hint: "[--doctor] [--metrics [slug]]"
disable-model-invocation: true
---

Input: `$ARGUMENTS`. `<cwd>` is the workspace root (the folder that holds `.claude/task-flow.md`).

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs list` and
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/resources.mjs reap --dry-run`: one short table per task — what it holds,
   its PRs, what the reaper would free now.
2. With `--doctor` (or when the user asks whether the setup works):
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs <cwd>` — what passed, what failed, how to fix each failure.
3. With `--metrics`: `node ${CLAUDE_PLUGIN_ROOT}/scripts/metrics.mjs <cwd> --all` (one line per run of the last
   30 days, with the plugin version), or with a slug `node ${CLAUDE_PLUGIN_ROOT}/scripts/metrics.mjs <cwd> <slug>`
   (every job: minutes, time in tools vs model, slowest commands). Show the table, then say in two or three
   lines where the time went (which role, which jobs, how many re-tests) — numbers only, no guesses about causes
   the output does not show. Steps 1–2 are skipped when only `--metrics` is given.

Reply in the user's language.
