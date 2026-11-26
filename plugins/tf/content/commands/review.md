---
name: review
description: "Review a team member's PR by reading the code: logic against the ticket, impact on other parts (functions, variables, types, contracts and who uses them), security, standards, typecheck/build. Static and fast - nothing is run on the app; use /tf:e2e for that. No code changes; drafts only. Workspace rules live in <workspace>/{{config}}."
args: "<PR url|ticket key> [--attach]"
user-only: true
---

{{fallback}}

Plugin root `<PLUGIN>` = `{{root}}`.

Read `{{root}}/docs/orchestrator.md` and follow it exactly, with:
- mode: **review**
- input and flags: `{{args}}`

{{notes}}
