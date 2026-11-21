# Changelog

All notable changes to the `tf` plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.22.1] — 2026-11-21

### Fixed
- **The issue key is the scope of every commit and PR title, and a PR title is English.** On Rồng Việt, 52 of 400
  backend commits put the key at the end (`feat(goalkeeper-award): … (RVD-306)`), one PR put it in brackets
  (`fix(goalkeeper): [RVD-306] …`), and many PR titles were Vietnamese copies of commit summaries. Commits were
  made per area of the plan, the area became the scope, and later packaging copied that style from `git log`.
  - `guidelines/git.md`: the key is always the scope, also with several commits per PR; a table of wrong vs
    right; PR titles are written in English for the PR; a repo convention counts only when written down.
  - The tool guard refuses `git commit -m` and `gh pr create|edit --title` that break these rules, and
    `gh pr create --fill` (it copies a commit summary).
  - `scripts/naming.mjs check` for messages the guard cannot read (`git commit -F`, a title in a variable); the
    PACKAGE reviewer runs it before committing and opening the PR.

## [1.22.0] — 2026-11-21

Measured over ten days: agents read `ticket.md` (up to 117 KB on a long task), the workspace config (16 KB) and
`flows.json` (up to 76 KB) whole, hundreds of times, and every read is re-read on every later turn.

### Changed
- **Each job reads only the config sections of its role.** `task.mjs config <root> --role setup|dev|tester|reviewer
  [<section>…]` prints those sections plus Hard rules (5–7 KB instead of 16 KB on a real config); every job prompt
  names the command. The PM still reads the whole file.
- **`ticket.md` holds what is in force.** Comments earlier rounds already worked from become one line each and go
  verbatim to `ticket-history.md` with old round blocks; `jira.mjs read --since <id> --history <file>` does the
  split (an edited comment counts as new). The PM opens the history only to quote it.
- **The tester reads `flow-run.mjs --list`** — one line per flow: last result, up to date or stale, seconds, first
  error — never `flows.json` (17 KB instead of 76 KB on RVD-297).
- **`_lib/README.md` is an index:** one line per helper file with its export names; arguments live in a one-line
  comment above each export, found with `grep`.
- **e2e-only instructions moved out of what every run reads:** `docs/pm-e2e.md` (the PM's case writing) and
  `docs/orchestrator-e2e.md` (the approved-cases gate and fast path); e2e prompts and `/tf:e2e` name them.

## [1.21.0] — 2026-11-21

### Added
- **`scripts/jira.mjs`: one way to read and post on Jira.** Twenty scratch `jira-read` / `jira-post` scripts were
  found in task folders, each written and debugged anew. `read` fetches the issue and every comment through the
  signed-in browser session (in the Jira page, as Atlassian requires) and writes the JSON plus, with `--md`, a
  readable copy about a seventh of its size. `comment` turns the markdown draft (tables, bold, links, lists,
  headings) into a Jira comment, with `--reply-to`, `--mention <accountId>=<name>` and `--expect-last` (stops
  when QC wrote something new); without `--confirm` it only shows what would be posted.

### Security
- The tool guard refuses `jira.mjs comment … --confirm` from every tf agent: posting stays the orchestrator's,
  after the user approved the exact text. Key, site origin and comment ids are checked before a browser opens;
  a draft with `<evd:…>` placeholders left is refused.

## [1.20.0] — 2026-11-21

Measured: the PM ran on opus in 205 of 250 turns, haiku almost never ran, and half of all agent time went into
rounds sent back by QC or reviewers. This release routes models by the kind of work and writes for people only
where people read.

### Changed
- **Models by the kind of work.** After its first turn the PM runs on sonnet whenever the last reports are green
  and it only dispatches the next group, whatever the size; it goes back to opus for a turn that must judge
  (FAIL, blocked, NEEDS-WORK, plan-check points, a rejected decision). Setup jobs run on haiku unless the PM
  gives `modelWhy`. A PACKAGE job never runs below sonnet (it writes the PR body). A haiku job that does not
  finish is tried once more on sonnet, from where it stopped. `pm.md` has the table.
- **`--approve` shows a summary written for the person approving** (`## Tóm tắt duyệt` at the top of plan.md:
  goal, requirements in plain words, one line per repo, not in this task, risks and questions — ≤ 15 lines, no
  paths), not the micro-task list.
- **The e2e test-case table shows what to expect:** `cases.mjs preview` is `ID · Tình huống · Mong đợi · Nền tảng
  · ⚠`, flows move to one counts line. Case titles are the situation in ≤ 8 words, `Mong đợi` one checkable
  sentence.
- **Agent-only text is terse.** Briefs, board, journal and job reports are `key: value` lines; prose is kept for
  what people read (approval summary, scope, cases, questions, ticket comment, PR body, review replies).

### Added
- **A prototype is checked before the PR.** When the task has one and UI changed, the tester shoots each changed
  screen beside it and lists the differences; the gate raises P2 when that comparison is missing (not a block —
  the prototype may be out of date).

## [1.19.0] — 2026-11-21

Measured on 167 tester jobs: about 70% of tester time went into fixing flow scripts and re-running them, and into
re-running every case once more at the end; an Android re-run averaged 114 s. This release cuts those loops.

### Added
- **Look at an Android screen before writing its steps.** `flow-peek.mjs <task> - --android <serial> [--steps …]`
  prints what the emulator shows as the selectors `androidFlow` takes (`{ id }`, `{ text }`, `{ desc }`, bounds,
  clickable) — instead of `adb input tap` + screencap + reading the image by hand.
- **A failed Android step leaves the screen as it was:** `evd/<case>-fail-<step>.ui.txt`, same format, returned as
  `page` like the Web `.page.txt`.
- **`flow-run.mjs --changed`:** skips a case that already PASSed on this commit, this target and this flow
  (`flowHash` = the flow file plus the `_lib` files it imports). The tester's final check uses it; nothing left
  to run returns `upToDate`.

### Changed
- **Each case has its own ceiling:** 180 s Web/API, 360 s Android (was 600 s for every case); the result names the
  step it hung in (`[tf-step]` lines from the flow kit). `--timeout` still overrides.
- **`flow-run` prints one short entry per case** (case, status, first error line, page dump, evidence);
  `--verbose` gives every field.
- **Long output stays out of the agents' context:** dev and lead run typecheck/build/lint/tests to a log and read
  its tail; the tester never `cat`s a file over ~20 KB, waits on background commands instead of `until`/`sleep`
  loops, and never re-runs the suite only to confirm cases that just passed.

## [1.18.1] — 2026-11-21

### Fixed
- **Two tasks can no longer hold the same resource.** `resources.mjs add` checks every other task of the
  workspace under a lock and refuses an id already held (exit 3, `held: cache 2 is held by task …`), so two setup
  jobs running at once cannot both take the same Redis db, port, database or emulator. Server names (`be`, `fe`)
  stay per task. Seen in the wild: one Redis db shared by two live tasks.

### Changed
- **`/tf:status` is one short table.** One row per task — PRs merged, what it holds, worktree disk, whether
  `/tf:clean` frees it now — plus totals and a ⚠ line for an id two tasks hold. Paths and release commands are
  left to `resources.mjs list` (new: `list --table`).

## [1.18.0] — 2026-11-18

### Added
- **`/tf:e2e` asks you to approve the test cases first.** The PM reads the ticket, its acceptance criteria and
  screens, the previous round's plan, the PR diff and any QC test-case list, and writes `cases.md`: one section
  per case (platform, screen, data, steps, expected), `AC → TC` coverage, ⚠ on guesses and vague expectations,
  open questions (each naming the cases it affects) and missing specs — then the run stops with status `cases`.
  Nothing runs before you edit and approve it. The questions come in the same stop; there is no separate
  `clarify` in e2e. `--assume` approves without stopping.
- **`scripts/cases.mjs`** — parse, validate, approve (freezes `cases.approved.json`), status, scope, preview and
  results. A case's `rev` covers only what changes the run (platform, screen, data, steps, expected); a flow is
  fresh for one rev; a result counts only for the same rev, target and commit.
- **Re-runs without an agent.** With approved cases unchanged, the orchestrator re-runs the flows that still
  match with `flow-run.mjs` alone and launches a tester only for stale, missing or failing cases; with nothing to
  run it just writes the results. The PM turn after approval runs on sonnet and does not re-analyse the task.
- **Evidence points at the bug.** `expect(cond, label, { at, expected, actual })` and `mark(at, label)` in the
  flow kit record the element (Web: locator, scrolled into view; Android: uiautomator bounds); the runner draws a
  red box and a red label on the shot, and a close-up when the element is small (`scripts/annotate.mjs`,
  Chromium; ffmpeg draws boxes only). `shot(name, { caption, crop })` captions an image.
- **Ticket comment in the QC layout**, written by `cases.mjs results --write`: environment line, a summary table
  of every approved case, then Vấn đề · Hiện tại · Mong muốn · Evidence for the failed ones, images copied to
  `evd/comment/` as `<SLUG>-<DDMM>-<case><a|b>-<what it shows>`. The verdict is `verified`, `verified-bugs` or
  `incomplete`.
- `task.mjs commit <taskDir>` — the HEAD of every task worktree plus a fingerprint of uncommitted changes.
- `flow-run.mjs --cases-file`, `--ensure-target`, `--mark-written`, `--commit`.

### Changed
- `flow-run.mjs` refuses instead of skipping: an id with no flow, an empty selection or an unsaved `--target`
  is an error (exit 2), never a green run. It keeps what other tools recorded about a case (`caseRev`) and
  stores the commit and target of each result.
- Case ids in file names are internal ids (`[A-Za-z0-9_-]`); QC ids stay in `cases.md` headings.
- The task lock is taken atomically and carries a token: only its holder renews or releases it, an expired
  lock is reported `stale` and taken only with `--steal`. The orchestrator stops the run's servers before it
  releases the lock.
- The engine rejects an e2e dispatch without approved cases, a tester job outside the run scope, and an e2e
  close that leaves a case of the run scope without a result.

## [1.17.0] — 2026-11-17

### Security
- **Rules every tf agent is held to, at the tool call.** Whatever a ticket, a PR comment or a page says, the
  guard refuses a tf agent (the PM included) that reads, lists, copies or edits the saved logins in
  `~/.claude/task-flow/auth`; merges, approves or reviews a PR; force-pushes; or posts a comment, reply or
  review. Posting stays with the orchestrator, after the user approved the text. The checks are string tests
  in memory — no process, file read or model call per tool call.
- **The PM has a fixed tool list** (`Read, Write, Edit, Grep, Glob, Bash`, CodeGraph) instead of every tool of
  the session.
- **Text other people wrote is data.** Each agent prompt says so in one short paragraph; `feedback.md` and each
  `## Source` of `ticket.md` are marked as written by other people.
- **A manual login keeps only the site's own cookies**, as the Chrome copy already did.
- **Metrics do not copy secrets.** A slow command quoted in `metrics.json` has passwords in URLs, bearer tokens
  and `KEY=value` credentials masked.
- **A workspace no longer lists a neighbour's sessions.** A transcript folder that only shares the name prefix
  (`/work/app-private` next to `/work/app`) is taken when its transcripts say it was started inside the
  workspace, and left out otherwise — for the artifact list and for metrics.

## [1.16.5] — 2026-11-17

### Security
- **The resource ledger no longer carries commands for what tf knows how to free.** For `worktree`, `port`,
  `server`, `browser` and `emulator` the action is built from the id; a `release`/`stop` string stored in
  `resources.json` is ignored. A worktree is removed only inside `.worktrees/`.
- **Other kinds run only the config's own recipes.** A stored command for a DB, a cache index… runs when it
  is one of that kind's backticked commands in the config's Provisioning table with plain one-word values in
  the `<placeholders>`. Anything else is kept, shown, and runs only with `resources.mjs release --unlisted`.
- **You see what cleanup will run.** `resources.mjs list` and `reap --dry-run` print the action per resource;
  passwords inside URLs are masked there and in the log.
- **A port release stops only the task's own listener** — a process running from the task's worktrees or
  task folder. Weeks after a run, whatever else listens on that port is left alone. `serve.mjs stop` likewise
  needs to see the server running from the task's worktree.
- **No shell around git and gh** in `resources.mjs`, `fresh.mjs`, `pool.mjs`, `task.mjs` and `doctor.mjs`:
  a branch, a base or a path is one argument. Branches and bases must be plain refs; pool keys, lock files
  and dependency folders must stay inside their folder; a dependency folder that is a symlink is refused.
- **Server placeholders never bring shell syntax**: `{db}`, `{cache}` and the others are refused when their
  value holds shell characters.

### Changed
- `resources.mjs add` needs `--release` only for kinds tf does not know.

## [1.16.4] — 2026-11-17

### Security
- **A canvas's scripts no longer run inside the export.** `canvas.mjs export` test-rendered each screen with
  `node:vm`, which a script can leave (it reaches the host's `Function` through any object it is handed) — a
  canvas you were sent could run code as you. The test render now happens in one separate process per export
  (`canvas-smoke.mjs`) under Node's permission model: no file writes, no child processes or workers, reads
  limited to its own two files, an empty environment. It refuses to start any other way.
- **A screen that never returns is stopped.** Each screen has 2 seconds, enforced around the whole render and
  every handler, with a deadline on the process behind it; a process that dies on one screen is reported and
  the rest are still rendered.
- A screen script that does not parse is now reported with its syntax error instead of
  "inst.render is not a function".

Needs Node 22.13 or later; on an older Node the screens are not run at all and the export says so.
Cost: about 30–40 ms per export, whatever the number of screens.

## [1.16.3] — 2026-11-17

### Security
- **A URL can no longer run a command.** `browser.mjs auth --url` put the URL's host into a `sqlite3` shell
  command. sqlite3 now runs without a shell and with a fixed query; cookie domains are matched at a domain
  boundary (`.example.com` no longer matches `notexample.com`).
- **An emulator serial from the ledger is one argument.** `emulator.mjs` runs adb and the emulator without a
  shell, and `stop` skips an entry that is not an emulator serial.
- **A canvas cannot name files outside its folder.** A board key or `<dc-import>` with `..`, an absolute path
  or anything but a `.dc.html` file is ignored by the export; a `file` field inside a board no longer replaces
  its key.
- **A task name is never a path.** `resources.mjs` refuses a slug with a separator or `..`.
- **Saved logins are private from the first byte.** Session files are created with mode 600 instead of being
  written and then restricted; the cleanup log is 600 too; the temp folder of the Chrome cookie copy is
  removed; the browser server listens on 127.0.0.1 only.

### Fixed
- **PACKAGE never runs on untested code in build and qc.** A dispatch that went dev → PACKAGE with no tester
  was accepted on XS/S tasks, so the PR was pushed before the close check refused it. It is now refused at
  dispatch.
- **A flow that wrote PASS and then crashed, was killed or timed out did not pass.** The run id is unique
  per invocation, so a verdict left by an earlier run never counts.
- **A cleanup dry run changes nothing.** It no longer restores tool-touched files in stray worktrees.
- **Cleanup keeps what it cannot judge.** A task whose PR state cannot be read (gh offline or logged out) is
  kept instead of deleted, and `.pipeline/digest/` is never treated as a task.

## [1.16.2] — 2026-11-17

### Fixed
- **A saved login stays fresh.** A browser opened with `auth` now writes the session back to
  `~/.claude/task-flow/auth/<name>.json` when it closes, so cookies the site rotated during use are kept and
  the next run does not have to log in again. The file is left as it was when the session was lost (a page on
  a login screen, or the site's cookies gone), and only the sites it already covered are saved.

## [1.16.1] — 2026-11-17

### Fixed
- **A worktree that is already gone no longer blocks cleanup.** Releasing a worktree whose folder no longer
  exists ran `git worktree remove`, failed with "not a working tree", and kept the task un-archived, so every
  cleanup retried and reported it. It now counts as released.

## [1.16.0] — 2026-11-17

### Changed
- **A task run no longer cleans up other tasks.** The preflight step that ran `resources.mjs reap` (and offered
  to install the reaper) is gone, so a run spends no time or tokens on freeing, archiving or reporting the
  resources of earlier tasks. `/tf:clean` with no argument is now the workspace cleanup: a dry run of `reap`,
  applied after the user's yes.

### Removed
- **The background reaper.** tf no longer installs a job that cleans up every 30 minutes; cleanup happens only
  when the user runs `/tf:clean`. `reaper.mjs` keeps `status` and `uninstall` to remove a job installed by an
  earlier version (`/tf:status --doctor` points it out), and `install-reaper.sh` is gone.

## [1.15.0] — 2026-11-17

### Added
- **A review of someone else's PR is posted as one review with inline comments.** `pr-feedback.mjs review`
  reads the draft, puts every finding whose `path:line` is in the PR diff on that line, and sends them with the
  Summary and Recommendation in a single comment review — one notification. Findings outside the diff stay in
  the body; it never approves or requests changes.
- **The review guideline names its standards.** `guidelines/pr-review.md` now reads a PR by the areas of
  Google's code review guide and checks security against the OWASP Top 10:2025, row by row; a security
  finding carries its row (`A01`…). A Sources section says which parts come from where and which are our own.

### Changed
- **`/tf:review` is a static code review.** It no longer runs e2e: one reviewer reads the PR for logic,
  impact on other parts (functions, variables, types, contracts and who uses them), security and standards,
  and runs typecheck/build. No tester, no app server, no emulator — a review is quick again. The report says
  `Not run on the app` and names what is worth an e2e; `/tf:e2e <PR>` runs it when the author asks. No ticket
  comment draft in review mode.

## [1.14.0] — 2026-11-17

### Added
- **One review round, one answer per PR.** `/tf:address-review` no longer posts a reply per thread and a
  comment per reviewer. Threads are still answered in place, every review and conversation comment is answered
  in one summary (a section per reviewer, a row per point), and both go out as a single submitted review
  (`pr-feedback.mjs post`): one notification, one entry in the conversation. The format is the new
  `guidelines/review-reply.md`.
- Reviewers who were asked and have not reviewed yet are shown before the run (`waiting`), with the choice to
  wait for them instead of answering twice.

## [1.13.0] — 2026-11-17

### Added
- **Requirements, design, tasks — as much paper as the task is big.** Every plan starts with `## Requirements`:
  the brief rewritten as numbered sentences a flow can check (`R1 When …, … .`) with the words they come from,
  and what the task will not do. Coverage maps `R<n> → micro-tasks → cases`. An M task adds a short `## Design`
  (data and what happens when it changes later, neighbours, interfaces, decisions with the alternative
  rejected); an L task writes `design.md` before the plan, with flow, states and risks as well.
- **An L task shows you its design before any code.** After the plan check the run stops with the design and the
  plan; a change you ask for sends the PM back to the design. `--assume` skips the stop. The plan check reads
  `design.md`, each dev lead writes its `## Approach` before the first edit, and the gate rates a diff that
  departs from the design without saying so as P2.

## [1.12.1] — 2026-11-17

### Fixed
- A job that cannot finish is no longer sent again and again. When the same kind of job on the same repo does
  not finish twice in a row (blocked, failed, no answer), the run stops: the PM gets one turn to write the
  board and the handoff, then the run escalates with both reasons, and says so when they look like a
  tool-permission block. RVD-298 had lost four `PACKAGE` jobs and seven PM turns to one such block.

## [1.12.0] — 2026-11-17

### Added
- **Small-task lane.** An XS or S task runs dev → tester (named cases) → one reviewer job in a single dispatch:
  that `PACKAGE` job is told no gate ran, runs the gate checklist first on the dev lead's model, and commits
  only when it is clean. Five agents and two PM turns instead of eight and three. A lane dev job that changed
  more than 3 files stops the dispatch so a gate runs before the tester.
- The PM sizes by the change, from a table of criteria, and a later round by what that round changes. Money,
  auth, permissions, migrations and read-only zones never go below M.

### Changed
- On M/L a `PACKAGE` job is rejected unless a gate SHIPped after that repo's last dev job. Nothing enforced a
  gate before; the PM could leave it out at any size.
- An XS task has dev jobs on one repo, no `FLOWS` job, and its lead never splits. No `FLOWS` job in a fix
  round. These were advice in `pm.md`; the executor now rejects them.

## [1.11.0] — 2026-11-17

### Added
- **An unclear task is asked about before anything runs.** After reading the brief, the config and the code,
  the PM sorts what is still open: a point with two plausible readings that lead to different things being
  built, and that nothing it read settles, is a question; the rest is an assumption. With questions the run
  stops before the plan (`clarify`), you answer them in a picker (each with the unclear words quoted, the
  options and the PM's own pick), product decisions can go to the PO as a drafted tracker comment, the answers
  are kept in `ticket.md` under `## Clarifications`, and the run starts again. A clear task runs straight on
  and says so in `scope`. At most 3 rounds, only before the first job; `--assume` never stops to ask.

## [1.10.0] — 2026-11-17

From a review of two days of runs (28 runs, 35 human review points on five tasks).

### Added
- **Existing tests are run.** The dev lead runs the repo's existing suite (new config section `## Checks`) and
  says for every failure whether its change broke it or it also fails on the base; the gate checks that. A
  test the diff broke and left red is P2; one deleted or skipped to get green is tamper. "No new unit tests"
  no longer reads as "do not run the old ones".
- **Impact check at the gate.** The reviewer lists the other users of every shared function, helper, component
  or query the diff changes; a user no case covers becomes an `IMPACT<n>` line, and the executor adds those to
  the tester jobs of that repo later in the same dispatch. They are cases, not defects: the verdict is unchanged.
- **Cases human reviewers ask for.** The plan carries a case at each limit, one per mode where FE and BE must
  agree, a regression case per other user of shared code, and a measurable statement of a visual defect; the
  plan check raises a missing one.
- **Visual cases must show a change.** Before and after shots of the region the ticket names must differ and
  the after state is asserted by measurement; identical shots are never a PASS.
- PR Testing section lists `branch → flow case → result` for the logic a PR adds, and the existing-tests result.
- `task.mjs engine <dir> <engine> [--title T]`: the task's copy of the engine is `<SLUG>.js` with the task id as
  the workflow's name, so `/workflows` shows `PROJ-268` instead of one `task-flow` per run.

### Fixed
- `flow-peek.mjs` crashed on start since 1.6.0 (`rootOfTask` was not imported), so testers could not look at a
  screen before writing its selectors.
- A tester that did not PASS now skips the later groups of its dispatch (build, qc, feedback): a `PACKAGE` job
  dispatched after it could commit and push code that had just failed.

### Changed
- Agent files say each rule once: text the executor already puts in every prompt (scratch folder, flow library
  owner, named cases, languages) and rules copied between `pm.md`, `lead.md`, `dev.md`, `tester.md` and
  `guidelines/e2e-testing.md` were merged or replaced by a pointer. No rule was dropped.

## [1.9.1] — 2026-11-16

### Changed
- Session title is now `<SLUG>: <summary>` (was `<SLUG> · <summary>`), so the ticket key reads as
  `PROJ-268: Fix OTP login timeout` in the session list.

## [1.9.0] — 2026-11-15

### Added
- **`/tf:digest` — a digest of your Zalo group chats.** Name the chats (or `all` from the config's new
  `## Chat sources`) and a window (`hôm nay`, `hôm qua`, a date, a range, `6h`, `since-last`): tf reads them in
  Zalo Web in your own Chrome and writes, per chat, what needs you, what was decided, what is still being
  discussed and the to-dos, each point with its time and sender. The window is counted from the page's own
  message metadata before reading, so the digest says exactly how much was read; stickers and system notices are
  skipped, an album is one line, and the photos people replied to are opened and read. A checkpoint per chat
  makes the next run start where this one stopped. Read-only: no login, no sending, no calls to Zalo's servers.

## [1.8.0] — 2026-11-15

### Added
- **Client feedback on every demo screen.** `/tf:demo` puts a Feedback button on each screen. In the published
  artifact it opens claude.ai's own comment box pinned to that screen (composer-only: the page posts nothing and
  asks no consent); clients invited by email at Commenter sign in and comment there. Where comments are not
  available (not signed in, a public link, the local demo) it opens `--feedback`: an email with the screen in the
  subject, or a form link with `{screen}` `{title}` `{demo}` `{url}` filled in; with neither, it is hidden.
  `--comments` reads the artifact's threads into `demo-feedback.md`, grouped by role and screen.

## [1.7.0] — 2026-11-15

### Added
- **`/tf:demo` — a design canvas becomes a clickable client demo.** Give it a Claude Design canvas link: every
  screen becomes a page that runs the screen's own code (`scripts/canvas.mjs` + `scripts/canvas-runtime.js`, React 18),
  so buttons, tabs, toggles, fields and the links between screens work as in the canvas's Play mode. Screens are
  grouped by role from the canvas's title notes, each role has a Start button and its own link (`#slug`), phone
  frames show in a device frame, web pages fill the window. Every screen is test-rendered in Node with each handler
  pressed before you see it. Runs locally; `--publish` makes it one private artifact. No repo, PR or agents.
  Measured on a 75-screen canvas: 8 roles found, every screen rendered, no warnings.
- **Any link, or no link at all.** Task commands take plain words, an issue key, or any link — tracker (Jira, Linear,
  YouTrack, GitHub issue), PR, Notion / Google Docs / Confluence, Figma, any web page, a claude.ai artifact, canvas
  or design system, a local file — alone or together (`scripts/sources.mjs`). `ticket.md` is now the brief: the
  user's words plus every source verbatim. Words alone are a complete task. Workspaces can say how to read a host
  in a new `## Sources` config section (the old `Tracker and spec sources` still works).
- **A canvas attached to `/tf:build`** is kept whole: every screen's source, a summary (roles, screens, devices,
  links, notes) and a clickable export. Devs rebuild screens from the real markup; testers compare against the export.

### Changed
- **Task folders from words and links read well and never collide.** `fix utf-8 encoding` no longer becomes task
  `UTF-8` (keys in plain words must be written in capitals, or use a prefix the config lists); Vietnamese filler
  words are dropped (`dung-demo-man-hinh-dat`); a link-only task is named after the page plus a short hash;
  `task.mjs resolve --name` names it outright.
- A ticket-comment draft is written only when a tracker issue is a source; branches of tasks without an issue key
  use the task slug.

## [1.6.2] — 2026-11-14

### Fixed
- **Worktrees a tool dirtied were never freed.** `flutter pub get` rewrites `analysis_options.yaml` on its
  own, so every mobile worktree counted as "uncommitted changes" and the reaper kept it for good (five of
  them on the measured workspace); the same file cost RVD-289 a gate round as an out-of-plan change. A
  workspace can now list such files under `## Tool-touched files`: tf puts them back as committed before a
  worktree is checked for unsaved work, and the reviewer gate does the same before reading the diff
  (`resources.mjs restore-touched <root> <worktree>`). Only tracked, modified, listed files are restored.

## [1.6.1] — 2026-11-14

### Changed
- **Docs say each thing once.** `docs/design.md` is the reference for the hard rules, sizing, files and
  retention; the README links to it instead of repeating the tables; what an agent must do stays in its own
  file. `design.md`'s hard rules are one ordered list again (it had two rules numbered 3c and still claimed
  the old limits of 10 turns and 6 jobs per dispatch).
- `agents/pm.md`: the dispatch rules are grouped (shape of a run, dev, testers, after a FAIL, models and
  setup, other modes); repeated rules removed; fix rounds no longer ask for a smoke case on XS/S, which
  contradicted "a small task runs only the cases it touches".
- `agents/tester.md`: "API before Web before App" and "run only your cases" are each said once.
- The PM prompt no longer points at `docs/design.md` (no PM opened it in the measured run; its rules are in
  `agents/pm.md` and in the prompt).
- README: the version badge (stuck at 1.1.0) links to the changelog instead.

### Added
- Tests: the limits written in `design.md` must equal the executor's constants, and every plugin file a
  document points at must exist.

## [1.6.0] — 2026-11-14

### Added
- **Linux and Windows.** Everything that differs between systems now lives in `scripts/platform.mjs`; no
  other script calls `lsof`, `launchctl`, `/bin/sh` or a macOS path.
  - Shell: `/bin/sh`, or Git Bash on Windows (`CLAUDE_CODE_GIT_BASH_PATH` honoured) — doctor fails without it.
  - Ports and processes: `lsof` or `ss` on Linux, `netstat` + `taskkill` on Windows; servers are started as a
    process tree that `serve.mjs stop` takes down on every system.
  - Reaper: `scripts/reaper.mjs install|status|uninstall` — launchd, a systemd user timer (cron without
    systemd), or a Task Scheduler task. `install-reaper.sh` still works and calls it.
  - Dependency copies: APFS clone, reflink where Linux has it, a plain copy elsewhere.
  - Paths: separators, `~/.claude` via `CLAUDE_CONFIG_DIR`, Android SDK defaults, `.exe`/`.bat` tools,
    Windows paths in the tool guard.
  - `node platform.mjs free-port <port>` and `kill <pid>` for workspace configs (the template uses them).
- **CI** (`.github/workflows/tf.yml`): script syntax, the executor rules and `tests/platform.mjs` — real
  ports, process trees, a server started and stopped by `serve.mjs`, resources released — on Ubuntu, macOS
  and Windows, Node 20 and 22.
- `/tf:status --doctor` shows the system, its shell, and what works differently there.

### Changed
- Tracker login from Chrome cookies is macOS only; elsewhere `browser.mjs auth` opens a browser to log in once.

### Security
- `task.mjs resolve`: the owner and repo of a pasted PR link went into a shell command unescaped; a crafted
  link could run a command. They are now limited to GitHub's name characters and passed to `gh` without a shell.
- Node 20 is end-of-life: tf now needs Node ≥ 22, CI runs 22, 24 and 26, and doctor warns when the running
  Node is older than the latest security release it knows (2026-11-11: 22.23.5, 24.22.3, 26.13.1).

### Fixed
- `resources.mjs end-run` exited 1 whenever the task still held a worktree, DB or port (which is always,
  until the PR merges). It now fails only when a resource it tried to release could not be released.

## [1.5.0] — 2026-11-13

### Added
- **Tool guard** (`hooks/guard.ts`): rules that were only sentences in a prompt are refused at the tool call —
  a dev job's `git commit|push|merge|rebase`, a team member's edit of a file given to another member, a
  read-only tester's write to the shared flow library. The guard recognises a job from the prompt the
  executor starts it with; anything else passes.
- **Ask the user only on disagreement**: after a plan check with points the PM returns `planKept`; a point
  where the plan stays as it was stops the run (status `approve`, `planOpen`) so the user settles it before
  any job runs. A corrected plan or a clean check runs straight on.
- **Small tasks test only what they change**: on XS/S every tester job names `cases` (enforced) and the
  tester runs only those — no other saved flow, no smoke case. `cases` is optional on M/L.

### Changed
- `agents/pm.md` 195 → 148 lines: feedback-mode rules moved to `docs/pm-feedback.md` (the engine points the
  PM at it in that mode only); rules the engine already states in the PM prompt are no longer repeated.

### Fixed
- **Metrics `byHand` over-counted**: it matched the word `kill` anywhere in a command (an echo, a comment,
  code being written) and counted each call twice. It now matches the program in command position and
  counts a call once; tool counts were doubled for the same reason. RVD-289 has 0, not 10.
- **Dev jobs that commit**: on RVD-289 a dev lead committed three times although only the reviewer packages.
  The lead now reports the worktree HEAD before and after its job; when it moved, the executor has the
  commits undone (`task.mjs uncommit`, changes kept; refused when already pushed) before the gate runs.
- **Testers running side by side**: each tester job gets its own scratch folder (`<task>/tmp/<job>/`) and is
  told never to clean what it did not create; with several testers in a group only the first may edit the
  shared flow library, the others read it and park new helpers in `flows/_new/`.

### Added (tests and scripts)
- `tests/engine.mjs`: the executor's hard rules run against mock agents (`node --test tests/engine.mjs`) —
  per-repo close, PACKAGE after PASS, plan check, job limits, writer ≠ judge, lead teams, commit undo,
  tester isolation.
- `task.mjs head <worktree>` and `task.mjs uncommit <worktree> <sha>`.

## [1.4.0] — 2026-11-13

### Added
- **Plan check**: on M/L build/qc runs `tf:reviewer` reads the ticket and the PM's plan once (brief `PLAN`,
  job `J0`, on the PM's model) before any job runs: missing requirements, a repo left out, assumptions the
  ticket contradicts, untestable cases — every point quotes the ticket. It cannot block: the PM fixes the plan
  or records why it stands. Plans gain a `## Coverage` section (requirement → micro-tasks → cases, and every
  repo `changed` / `not changed — why`).
- **Scope line**: the PM's first decision carries `scope` (repos changed and not, cases, risky assumptions),
  logged by the run and repeated in the report.
- Metrics: the plan check is its own role column (`plan`).

### Changed
- **The reviewer gate runs on the model of the dev lead it judges** (the repo's last dev job); the executor
  sets it. PACKAGE jobs keep the PM's model.
- **Close is judged per repo**: a repo needs a tester PASS after its own last dev job. A later fix on another
  repo no longer forces a re-test and a second PACKAGE (measured on RVD-289: 2 jobs and 2 PM turns wasted).
  A FAIL followed by a PASS in a later group (a flow or test-data error re-run) no longer blocks the close.
- **Job limits**: 12 jobs per dispatch and 6 per group (was 6 per dispatch, counting groups that run one
  after another); 12 PM turns (was 10).
- The PM is told the hard rules in its first prompt and after a rejection, generated from the engine's constants.

### Fixed
- **Artifacts band empty in some sessions of the same workspace**: the band remembered the directory the
  session started in, but the desktop app starts a session in a pre-warmed spare folder and moves it to the
  workspace afterwards. It now asks for the session root on every refresh, and says `could not list` with the
  reason when the listing fails instead of looking empty.

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
