---
name: e2e
description: Run e2e only for a ticket or PR. The PM writes the test cases (cases.md) and stops; the user edits and approves them; then exactly those cases run — saved flows that still match re-run without any agent, the tester writes or fixes the rest. Evidence marks each bug (red box and label), plus a ticket-comment draft in the QC layout. No code changes. Workspace rules live in <workspace>/{{config}}.
args: "<PR url|task> [--cases TC1,TC2] [--target local|dev] [--assume] [--attach] | --regression [--target local|dev]"
user-only: true
---

Plugin root `<PLUGIN>` = `{{root}}`.

Read `{{root}}/docs/orchestrator.md` and `{{root}}/docs/orchestrator-e2e.md` and follow them exactly, with:
- mode: **e2e** — section 2e (orchestrator-e2e.md) decides between the test-case gate, the fast path and a tester run
- input and flags: `{{args}}` (`--assume`: approve the PM's cases without asking; `--target`: the target to run on)

`--regression` instead of a ticket: no workflow — run the workspace regression suite (flows promoted from
merged tickets): `node {{root}}/scripts/flow-run.mjs <cwd>/.pipeline/_regression --target <t>`
(default `local`; Playwright package from the workspace config `## Flows`) and report PASS/FAIL per case.

{{notes}}
