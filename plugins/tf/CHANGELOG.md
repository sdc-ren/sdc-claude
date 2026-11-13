# Changelog

All notable changes to the `tf` plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.2.0] — 2026-11-13

### Changed
- build/qc: the reviewer gate runs before the tester (enforced). A gate `NEEDS-WORK`/`BLOCK` skips the
  later groups and hands the report to the PM; P3 points never trigger another dev/test cycle. Fix rounds:
  dev → gate → tester `--failed` + smoke. PM plans each case with the data it needs.
- Setup leaves the app servers running for the whole run instead of smoke-and-stop.

### Added
- `/tf:feedback <ticket|PR> [--check]`: the team's review on our PRs. `scripts/pr-feedback.mjs` fetches
  unresolved threads (stable ids `R<n>`), reviews and conversation comments; the PM triages each point
  (fix / discuss / answered / out-of-scope), fixes only `fix` points on the same PR (tester only for flows the
  fix touches, `close.noTest` for non-behaviour fixes) and drafts one reply per thread; the orchestrator posts
  and resolves after approval. `/tf:qc` no longer folds PR reviews in.
- `scripts/serve.mjs`: start/reuse/stop the task's app servers from the workspace config `## Servers`
  (task ports, DB, cache filled in, health-checked, logs in `<task>/logs/`), ad-hoc processes via `run`;
  servers are `run-end` resources, so `end-run` stops them. Devs and testers use it instead of hand-made commands.
- `fastdeps.mjs` reports `stale-deps` when the main checkout's `node_modules` misses a direct dependency
  or holds another version than the lock; `pool.mjs fill --install` installs inside the pool in that case.

## [1.1.0] — 2026-11-13

### Changed
- Fewer commands: `/tf:build`, `/tf:qc`, `/tf:review`, `/tf:e2e`, `/tf:status`, `/tf:clean`.
  `/tf:doctor` → `/tf:status --doctor`; `/tf:cleanup`, `/tf:migrate`, `/tf:legacy` → `/tf:clean <slug> | --migrate | --legacy`;
  `/tf:regression` → `/tf:e2e --regression`. The internal workflow no longer shows up as `/tf:task-flow`.

### Added
- An **Artifacts (n)** band above the chat input (terminal and desktop app) lists the workspace's artifacts
  and design systems as buttons; picked ones are appended to the next message.
- Attach Claude artifacts, canvases and design systems to a task: `--attach` (checkbox list), a pasted claude.ai artifact link, or `@` in the terminal CLI (the plugin's
  `artifacts` MCP server lists them as resources).
- The list is built automatically for the workspace, with no setup: what its Claude Code sessions created
  (`scripts/artifacts-local.mjs`), what earlier tasks attached, and an optional pinned design system.
  Other projects' artifacts never appear.
- Attached items are read into `.pipeline/<TICKET>/specs/` and recorded in `attachments.json`; the PM plans
  from them, devs use the design system's tokens and components, testers check UI against it. Later rounds
  reuse them.

## [1.0.0] — 2026-11-13

First public release of task-flow v2 as a Claude Code plugin.

### Added
- PM-led executor: the `tf:pm` agent plans each ticket into micro-tasks, sizes it (XS–L), picks roles and
  models per job, reads reports, and closes or escalates. A thin workflow runs its dispatches and enforces
  hard rules in code.
- Agents `tf:pm`, `tf:dev`, `tf:tester`, `tf:reviewer` (reviewer gate + `PACKAGE` step).
- Commands `/tf:build`, `/tf:qc`, `/tf:review`, `/tf:e2e`, `/tf:doctor`, `/tf:status`, `/tf:cleanup`,
  `/tf:migrate`, `/tf:legacy`, `/tf:regression`.
- Hard rules: tester PASS on the latest code for every changed repo, PR only from a reviewer job started
  after that PASS, PRs always ready (draft only with `--draft`), writer ≠ judge, caps on turns and fix loops.
- One folder per ticket (`.pipeline/<SLUG>/`) and one worktree folder per ticket
  (`.worktrees/<SLUG>/<repo>/`), resolved deterministically by `task.mjs`.
- `HANDOFF.md`, `board.md`, `journal.md` so a later round starts from a short card instead of long specs.
- Re-runnable e2e flows (`flow-kit.mjs`, `flow-run.mjs`) for web (Playwright) and Android (adb), with
  `waitApi` / `ready` / `gotoReady`, WebP evidence, console/5xx warnings, opt-in traces.
- Speed helpers: warm worktree pool (`pool.mjs`), dependency cloning (`fastdeps.mjs`).
- Maintenance: reaper (free resources of merged tasks, promote passing flows to `_regression/`, prune idle
  tasks), `doctor`, `migrate`, `legacy`.
- Guidelines bundled: git, PR description, PR review, ticket comment, e2e testing.
- Per-workspace configuration in `<workspace>/.claude/task-flow.md`, including languages, read-only zones,
  test policy, review lessons and doctor checks.

[1.1.0]: https://github.com/sdc-ren/sdc-claude/releases/tag/tf-v1.1.0
[1.0.0]: https://github.com/sdc-ren/sdc-claude/releases/tag/tf-v1.0.0
