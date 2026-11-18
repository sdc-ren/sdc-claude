---
name: e2e
description: Run e2e only for a ticket or PR. The PM writes the test cases (cases.md) and stops; the user edits and approves them; then exactly those cases run — saved flows that still match re-run without any agent, the tester writes or fixes the rest. Evidence marks each bug (red box and label), plus a ticket-comment draft in the QC layout. No code changes. Workspace rules live in <workspace>/.claude/task-flow.md.
argument-hint: "<PR url|task> [--cases TC1,TC2] [--target local|dev] [--assume] [--attach] | --regression [--target local|dev]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator.md` and follow it exactly, with:
- mode: **e2e** — section 2e of orchestrator.md decides between the test-case gate, the fast path and a tester run
- input and flags: `$ARGUMENTS` (`--assume`: approve the PM's cases without asking; `--target`: the target to run on)

`--regression` instead of a ticket: no workflow — run the workspace regression suite (flows promoted from
merged tickets): `node ${CLAUDE_PLUGIN_ROOT}/scripts/flow-run.mjs <cwd>/.pipeline/_regression --target <t>`
(default `local`; Playwright package from the workspace config `## Flows`) and report PASS/FAIL per case.
