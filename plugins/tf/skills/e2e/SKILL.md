---
name: e2e
description: Run e2e only for a ticket or PR (saved flows re-run, new flows written for missing cases), with evidence and a ticket-comment draft. No code changes. Workspace rules live in <workspace>/.claude/task-flow.md.
argument-hint: "<PR url|ticket key> [--cases 21,22] [--attach] | --regression [--target local|dev]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/orchestrator.md` and follow it exactly, with:
- mode: **e2e**
- input and flags: `$ARGUMENTS`

`--regression` instead of a ticket: no workflow — run the workspace regression suite (flows promoted from
merged tickets): `node ${CLAUDE_PLUGIN_ROOT}/scripts/flow-run.mjs <cwd>/.pipeline/_regression --target <t>`
(default `local`; Playwright package from the workspace config `## Flows`) and report PASS/FAIL per case.
