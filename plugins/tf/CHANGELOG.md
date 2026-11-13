# Changelog

All notable changes to the `tf` plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-11-13

### Added
- An **Artifacts (n)** band above the chat input (terminal and desktop app) lists the workspace's artifacts
  and design systems as buttons; picked ones are appended to the next message.
- Attach Claude artifacts, canvases and design systems to a task: `/tf:attach <ticket> [keyword]` or
  `--attach` (checkbox list), a pasted claude.ai artifact link, or `@` in the terminal CLI (the plugin's
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
