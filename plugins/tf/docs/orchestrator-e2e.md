# tf orchestrator — e2e (`/tf:e2e`)

Read with `docs/orchestrator.md` for an e2e run; `S`, `W`, `C` and `<dir>` mean what they mean there.

## 2e. E2E: approved test cases, then the cheapest run

`commit` below = `node $S/task.mjs commit <dir>` (the code under test: the HEAD of each task worktree). Empty
(no worktree yet) → no result is reused: the whole snapshot is the run scope. Every step runs while this run
holds the lock.

1. **State** — `node $S/cases.mjs status <dir> --commit "<commit>"`.
   - No `cases.md` / no snapshot, `edited` (the user changed cases.md after approving) or `requirementsChanged`
     (ticket or specs changed since) → **gate**: launch with `snapshot` unset (the PM writes or updates
     cases.md and stops with status `cases`).
2. **Fast path** — approved, nothing edited or changed: `node $S/cases.mjs scope <dir> --commit "<commit>" --out
   <dir>/tmp/scope.json` → the cases without a valid result.
   - Empty → nothing to run: `node $S/cases.mjs results <dir> --commit "<commit>" --write`, then section 3.
   - Of those, the ones whose flow is `fresh` run with no agent: local target → `node $S/serve.mjs start <cwd>
     <slug>` (and the emulator for App cases, `emulator.mjs`); `node $S/flow-run.mjs <dir> --ensure-target <t>`;
     `node $S/flow-run.mjs <dir> --cases-file <fresh ids> --target <t> --commit "<commit>"`. Its `requested` must
     equal the ids you passed — a missing id or an error is not a result.
   - Then `cases.mjs scope` again: still not valid (stale or missing flows, FAIL, BLOCKED, a boot or runner
     error) → launch with `snapshot: "<dir>/cases.approved.json"` and `runScope` = those ids. Nothing left →
     `cases.mjs results --write`, section 3, no workflow.
   - `--cases a,b` from the user narrows the scope to those ids.
3. **Launch** (gate or tester run) with the normal args plus `snapshot`, `runScope`, `editRound`.

**Status `cases`** (nothing has run; release the lock — `end-run`, then `unlock --token` — while the user reads):
1. Show `node $S/cases.mjs preview <dir>` as it prints (one row per case: situation, expected result, platform, ⚠), then the counts: cases per
   platform, acceptance criteria without a case, ⚠, target.
2. Questions → `AskUserQuestion` as for `clarify` (the PM's pick first, recommended; `who: po` adds "Hỏi PO").
   Answers go under `## Clarifications` in `ticket.md`, each with the cases it affects.
3. `missingSpecs` → list them; the user attaches (`--attach`, a link — `docs/attach.md`) or says to go on.
4. Open `<dir>/cases.md` for the user (`mcp__ccd_host__open_in_editor` when available, else its path) and wait
   until they say it is done. They may also ask you to change it — edit cases.md as they say.
5. Lock again (`lock <dir>`, new token), then:
   - answers or new specs that change what is tested → relaunch WITHOUT `snapshot`, `clarifyRound` from the
     result, `editRound` + 1; the PM updates cases.md and it is shown again;
   - otherwise → `node $S/cases.mjs validate <dir>` (errors → show them, the user fixes, repeat) →
     `node $S/cases.mjs approve <dir>` → `node $S/flow-run.mjs <dir> --ensure-target <target>` when the target is
     remote (local is built after setup) → continue at step 2 of this section.
   - `assume: true` in the result (`--assume`): approve at once and go on — nobody is asked.

**Status `verified`** (e2e): the verdict is what `node $S/cases.mjs results <dir> --commit "<commit>" --write`
says — `verified` (all PASS), `verified-bugs` (a Failed case), `incomplete` (not verified or blocked cases).
Report it with the summary table; the marked images are under `<dir>/evd/comment/`.
