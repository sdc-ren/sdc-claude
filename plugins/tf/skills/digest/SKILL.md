---
name: digest
description: Read the user's Zalo group chats (Zalo Web, their own account, in their Chrome) for a time window — today, yesterday, a date, since the last digest — and write what was decided, what is still open and what needs the user, each point traced to its messages. Stickers and system notices are left out; photos people talked about are looked at.
argument-hint: "<chat name(s) | all> [hôm nay | hôm qua | YYYY-MM-DD | DD/MM | A..B | 6h | since-last] [--photos N] [--focus \"…\"] [--lang vi]"
disable-model-invocation: true
---

Plugin root `<PLUGIN>` = `${CLAUDE_PLUGIN_ROOT}`.

Read `${CLAUDE_PLUGIN_ROOT}/docs/digest.md` and follow it exactly, with input and flags: `$ARGUMENTS`.
