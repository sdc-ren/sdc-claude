# tf:pm — feedback mode (`/tf:address-review`)

The PM reads this file first on every turn of a feedback run; nothing here applies to other modes.

Input: `<task>/feedback.md` — per PR its review decision (`APPROVED` / `CHANGES_REQUESTED` / none) and state
(open / merged), then unresolved review threads `R<n>` (stable ids), reviews and conversation comments;
`[new]` = written after the PR's last commit, `[replied]` = we answered last. What an earlier round already
handled (we answered last and nothing new came; a review or comment shown before) is one line there, its full
text in `<task>/feedback-history.md` — open that only to quote it.
1. **Triage** every point into `<task>/feedback-triage.md` before planning. A review posted as one long
   comment holds many points: split it, id them `<comment author>-<n>` (e.g. `tnthangvn-3`). Table:
   `id | PR | reviewer | file:line | point (one line) | P0–P3 | M | verdict | fix in repo | reason`, `M` the miss
   category of `${CLAUDE_PLUGIN_ROOT}/guidelines/review-standard.md` the point falls in (`M1`…`M9`, `team` for a
   team agreement, `—` for a question, `new` when none fits), verdict one of
   `fix` (do it), `discuss` (we disagree — cite the ticket, a decision in board.md/config, a spec, or the
   code; never "won't fix" without a reason), `answered` (a question, no change), `out-of-scope` (belongs
   to another ticket — say which or propose one). Check the code before judging (codegraph, the worktree).
   Rules from the workspace config (test policy, read-only zones, decisions) beat a reviewer's ask: a point
   that contradicts them is `discuss` with that rule as the reason. `[replied]` threads with nothing new:
   skip unless the reviewer answered. With `check=true` stop here and return `close`.
   **Several PRs (BE / FE / App)** — each PR is judged on its own; touch only what a point requires:
   - **Fix in repo** is where the change lands, not where the comment was written ("BE should return X" on
     the FE PR → fix in be). The same problem raised on several PRs is ONE point (list every PR it came
     from; each gets a reply).
   - **APPROVED PR**: never push to it for P3/suggestions (a push may dismiss the approval and costs a
     re-review) — reply `answered`/`out-of-scope`, or `discuss`. Push to it only for (a) a P0–P2 bug a
     reviewer points out, or (b) a contract change below. Its reply then says why and asks for a re-review.
   - **Contract change**: a `fix` that changes an API contract (path, status, field name/type/optionality,
     enum, response shape, error key) pulls every client repo that calls it into the plan, approved or not,
     with a `## Contract` section, and the gate checks server vs client. Prefer a backward-compatible fix
     (keep the old field, add the new one) when the reviewer's point allows it — then no client change.
   - **Merged PR**: never pushed to. A change it now needs goes to a new branch from its base and a new PR;
     the replies on both PRs link each other.
   - A PR with no `fix` point gets no dev, gate, tester or PACKAGE job.
2. **Plan** only the `fix` points, as micro-tasks per repo on the PR's existing branch and worktree (setup
   only if the worktree is gone). Cases = only the saved flows whose behaviour the fix touches
   (`flows.json`), and of those the cheapest that still covers the change: API flow > Web flow > App flow —
   an App flow (emulator + APK build) only when App code changed or the behaviour is App-only. The tester
   drives the other repos' PR branches as they are, so an untouched approved PR is still exercised against
   the fixed backend. A fix that changes no behaviour (naming, comments, dead code, formatting, types) needs
   no tester — close with `close.noTest` and the reason. One dev job per repo, then gate (its brief lists
   the point ids it must see addressed) → tester (if any) → PACKAGE (push to the same PR, refresh the
   Testing section; never a new PR while the old one is open).
3. **Close**: write `<task>/feedback-replies.md` per `${CLAUDE_PLUGIN_ROOT}/guidelines/review-reply.md` — read it
   first. One `## <PR url>` block per PR that needs an answer: `### Summary` answers every review and
   conversation comment of that PR in ONE text (a section per reviewer, a row per point id), and one
   `### R<n> · resolve: yes|no` block per open thread answered in place. `fix` → what changed + commit sha
   (from the PACKAGE report), resolve yes; `discuss` → the reason, polite and concrete, resolve no;
   `answered` → the answer, resolve no (the reviewer decides); `out-of-scope` → where it goes. Never one
   reply per reviewer or per conversation comment. Nothing is posted by you — the orchestrator posts the
   round after the user approves. No ticket comment in feedback mode.
