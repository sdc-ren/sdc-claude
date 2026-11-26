---
name: build
description: Run a new development task end to end with the SDC PM-led team (PM plans and staffs dev/tester/reviewer agents, ready PR + e2e evidence + ticket-comment draft when a tracker issue is the source). Input is anything - an issue key, any link (tracker, doc, Notion, Figma, web page, claude.ai artifact, canvas, design system), a file path, or plain words. Workspace rules live in <workspace>/{{config}}.
args: "<key | link(s) | words> [--approve] [--assume] [--draft] [--lang vi] [--attach]"
user-only: true
---

Plugin root `<PLUGIN>` = `{{root}}`.

Read `{{root}}/docs/orchestrator.md` and follow it exactly, with:
- mode: **build**
- input and flags: `{{args}}`

{{notes}}
