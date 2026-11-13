# Changelog

All notable changes to the `tf` plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.3.0] — 2026-11-13

### Added
- **Run metrics** (`scripts/metrics.mjs`): every run is measured from its agents' transcripts — wall time,
  minutes per role, time in tools vs model per job, slowest commands, re-tests, tokens, plugin version. The
  orchestrator records it in `<task>/metrics.json` after each run and reports it; `/tf:status --metrics [slug]`
  lists runs to compare versions.

### Changed
- **Flows are written while the devs work**: the PM adds one tester job whose brief starts with `FLOWS` to the
  group of the first dev jobs. It writes the flows from the plan's cases and contract, returns verdict NONE,
  never counts as a test and never blocks later groups (engine rule 2a). Plans now name the `data-testid`s
  of new UI elements so flows and code meet.
- **A tester FAIL must be proven before a dev is sent**: the tester checks the data precondition and
  reproduces the failure directly; an `IB` carries that proof, anything else is `unconfirmed`, `flow-broken`
  or `test-data`. The PM only puts proven `IB`s into a fix job.
- **Shared flow library**: `<root>/.pipeline/_lib/` (`FLOW_LIB`, `lib` in the flow context) holds the
  workspace's login, seeding and other helpers with a `README.md` index; flows import it and the tester adds
  to it instead of writing a `flows/lib/` per ticket.
- **Look before writing**: new `scripts/flow-peek.mjs` opens a screen (after optional steps) and prints the
  real test ids, form labels and role + name locators; a failed web step now also saves
  `<case>-fail-<step>.page.txt` with the same description, reported as `page` by `flow-run.mjs`.
- Tester: run one case while writing it, look at the real response before editing, API flows before Web flows.
- **Dev lead per repo** (`tf:lead`, new agent): the PM dispatches one dev job per repo; the repo's lead does
  it alone, or splits it among up to 3 `tf:dev` members with an explicit, non-overlapping `files` list each and
  the interfaces between them, then merges — applies what members left for it, fixes the seams, runs the
  whole-repo typecheck/build — and sends the PM one report. The engine runs the members, rejects an invalid
  team (sent back once), and refuses two dev jobs on one repo in a group (rule 2b). The PM no longer plans who
  edits which file. Dev jobs per repo per run: 4 → 6.
- **Parallel testers**: the PM splits 6+ new cases (or different platforms) over 2–3 tester jobs by case ids;
  `flow-run.mjs --jobs N` runs cases concurrently and merges its results into `flows.json` instead of
  overwriting it.
- All "v1 / v2" wording is gone; `task.mjs resolve` reports `format: current | old | new`.
- Metrics also count servers started or killed by hand instead of through `serve.mjs` (`byHand`).
- The **Artifacts** band above the chat input is now always shown once the session starts: a workspace with
  no artifacts shows `Artifacts (0)`, and opening it explains how items get there. Before, the band hid
  itself when empty, which looked like it had failed to load (e.g. after switching account).

### Fixed
- The `tokens` list in the workflow result is gone: it was a difference of the shared budget counter, wrong
  whenever jobs ran in parallel (a dev job that produced 10k output tokens showed `0k`).

## [1.2.2] — 2026-11-13

### Changed
- `/tf:feedback` renamed to **`/tf:address-review`**: the app's command menu hid `tf:feedback` (likely the
  built-in `/feedback`). The internal mode and files keep the name `feedback` (`feedback.md`, `feedback-triage.md`).

### Fixed
- `skills/qc` and `skills/review` frontmatter: the descriptions held `: ` and were invalid YAML (now quoted).

## [1.2.1] — 2026-11-13

### Changed
- `/tf:feedback` with several PRs (BE / FE / App): each point records the PR it came from and the repo the
  fix lands in; duplicates across PRs are one point. APPROVED PRs are pushed to only for a P0–P2 bug or a
  contract change (reply asks for a re-review); a contract change pulls every client repo in (backward-
  compatible fix preferred); a merged PR is never pushed to (new PR from base); PRs without a `fix` point
  get no jobs. `feedback.md` starts with a per-PR table (state, review decision, push allowed); the
  orchestrator passes merged PRs too.
- Tester picks the cheapest flow per case (API > Web > App; emulator/APK only for App changes).
- Reviewer PACKAGE: a conflicting PR gets the base merged in (no rebase, no force-push).

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

First public release of task-flow as a Claude Code plugin.

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
