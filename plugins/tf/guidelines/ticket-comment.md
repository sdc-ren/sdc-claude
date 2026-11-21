# Ticket comment (test results)

For QC/PM: what was verified and the result. Technical detail belongs in the PR.

```markdown
Môi trường: dev · Chrome 1440px · vai BTC · commit abc1234 · 2026-11-18

| ID | TC | Kết quả | Evidence |
|---|---|---|---|
| A1 | Thẻ phạt ảnh hưởng thứ hạng | Failed — BUG: đội bị thẻ vẫn hạng 1 | <evd:RVD-297-1811-A1a-doi-bi-the-van-hang-1.webp> |
| B2 | Ngưỡng dự phòng để trống báo lỗi | PASS | <evd:…> |

Chi tiết lỗi:

| # | Vấn đề | Hiện tại | Mong muốn | Evidence |
|---|---|---|---|---|
| A1 | Thẻ phạt không ảnh hưởng thứ hạng<br>Nguồn: AC3 | • Đội FP-1 bị 1 thẻ vàng vẫn hạng 1<br>• fair_play_points = 0 | • Đội ít điểm kỷ luật hơn xếp trên | <evd:…a.webp> *Đội FP-1 bị thẻ vẫn hạng 1*<br><evd:…b.webp> *Cấu hình có tiêu chí Fair Play* |

Not tested: <case> — <reason, what is needed>
For QC: <1–2 lines only if QC must do something, e.g. retest after deploy>
```

e2e writes this draft itself: `scripts/cases.mjs results <task> --write` (one row per approved case; the second
table from the marks of the failed cases; images copied to `evd/comment/` and named
`<SLUG>-<DDMM>-<case><a|b|c>-<what it shows>`). Build/qc drafts follow the same layout by hand.

## Rules

- Only three verdict words: PASS, Failed, BUG. Each Failed row states the BUG and its impact in one
  sentence. Intended design differences are not bugs; out-of-scope bugs get a separate ticket.
- Every row has evidence. Where images are stored is set per workspace.
- A Failed row's image shows the bug: a red box around the wrong element and a short red label next to it
  (the runner draws them from the flow's `expect(..., { at, label })` / `mark()`); a close-up when the element
  is small; one image per screen when the bug is a difference between screens. Each image has a one-line caption.
- No PR link (the branch name links it), no copied acceptance criteria, no deploy steps (in the PR),
  no explanatory prose.
- Replying to a QC report: reply under the QC comment, same table with one row per reported case,
  result `Fixed` / `Not fixed — reason`, and state whether the fix is deployed for retest.
- One comment per test round; rerun → edit it, do not add "update" comments.
- Show the draft to the user and post only after approval. No agent attribution. On Jira the orchestrator
  posts with `scripts/jira.mjs comment … --confirm` (markdown tables, bold, links and lists become a Jira
  comment; `--expect-last` stops when QC wrote something new meanwhile). Agents never write their own
  Jira read/post scripts.
- Table headings may be translated; content follows the writing language.
