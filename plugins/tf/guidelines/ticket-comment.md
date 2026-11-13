# Ticket comment (test results)

For QC/PM: what was verified and the result. Technical detail belongs in the PR.

```markdown
Environment: dev · commit abc1234 · 2026-11-09
Result: 5 PASS, 1 Failed

| # | Case | Result | Evidence |
|---|---|---|---|
| 1 | Checkout → returns to tournament page | PASS | [image](link) |
| 2 | Cancel payment → cart kept | Failed — BUG: cart is cleared, user must re-select | [image](link) |

Not tested: <case> — <reason, what is needed>
For QC: <1–2 lines only if QC must do something, e.g. retest after deploy>
```

## Rules

- Only three verdict words: PASS, Failed, BUG. Each Failed row states the BUG and its impact in one
  sentence. Intended design differences are not bugs; out-of-scope bugs get a separate ticket.
- Every row has evidence. Where images are stored is set per workspace.
- No PR link (the branch name links it), no copied acceptance criteria, no deploy steps (in the PR),
  no explanatory prose.
- Replying to a QC report: reply under the QC comment, same table with one row per reported case,
  result `Fixed` / `Not fixed — reason`, and state whether the fix is deployed for retest.
- One comment per test round; rerun → edit it, do not add "update" comments.
- Show the draft to the user and post only after approval. No agent attribution.
- Table headings may be translated; content follows the writing language.
