# tf:pm — e2e test cases (`/tf:e2e`)

The PM reads this file on every turn of an e2e run (the prompt names it); nothing here applies to other modes.

The user approves the test cases before anything runs. Without a snapshot in your prompt your whole turn is:
read, write `cases.md`, return `cases`. No job, no server, no browser.

**Read**, in this order: `ticket.md` (new comments are marked) · the previous round's plan
`history/r<n-1>/plan.md` (`## Cases`, `## Coverage`, `## Contract`) if there is one · `HANDOFF.md` · `flows.json`
(which cases already have flows) · the PR diff (`gh pr diff <url> --name-only`, then the UI files it touches) ·
`specs/` · a QC test-case list when the brief has one (a sheet, a file, a comment).

**Write `cases.md`** — one section per case, fixed fields (the parser is `scripts/cases.mjs`):
```markdown
# Test cases — <SLUG>
Target: local | dev | <saved target>

## Câu hỏi
- Q1 — "<quote>" — A) … B) … — đang giả định: A — ảnh hưởng: TC3, TC5 — hỏi: user | po

## Spec còn thiếu
- <screen / flow> — <what is missing> — bổ sung: --attach or a link

## AC → TC
- AC1 — <summary>: TC1, TC2
- AC3 — <summary>: ⚠ chưa có TC — <why>

## Cases

### TC1 — <title>
- Nguồn: AC1 | QC:<their id> | IMPACT<n> | đề xuất
- Nền tảng: Web | App | API
- Màn hình: <route or screen>
- Data: <what the case seeds — role, status, counts>
- Bước:
  1. <step>
- Mong đợi: <what the user sees / the API returns — measurable>
- Ưu tiên: P1 | P2 | P3
- Ghi chú: <⚠ assumption Q1=A, …>
```
- The user reads the cases as a table (`cases.mjs preview`: ID · Tình huống · Mong đợi · Nền tảng · ⚠): the
  heading title is the situation in ≤ 8 words ("Bỏ trống tên giải → báo lỗi"), and `Mong đợi` is ONE sentence
  someone can check by looking (what is shown, the status and body returned). Steps and data stay below for
  the tester.
- A QC list is the main source: keep their ids as the headings (`### A1 — …`), add `đề xuất` cases only for
  acceptance criteria they do not cover. `IMPACT<n>` cases from the build round stay cases.
- Every acceptance criterion gets a line under `AC → TC`; one you cannot test gets ⚠ and why.
- ⚠ on whatever the user should look at: an expected result you had to guess or that is vague ("hiển thị
  đúng" is not testable — write what is shown), a case that cannot be automated (real OTP, third party), an
  assumption.
- `Target`: `dev`/staging when the config has it and the PR is deployed there, else `local`.
- With an earlier snapshot (`cases.approved.json`) and a changed ticket or spec: start from it, keep the user's
  edits, mark ⚠ the cases the change touches.
- Check your file: `node ${CLAUDE_PLUGIN_ROOT}/scripts/cases.mjs validate <task>` must be `ok` before you return.

**Ask or assume (e2e)** — the same bar as "Clear or not", about what gets *tested*: ask when two readings of
an expected result, a role/permission, the data, the platform, the scope or the environment are both
plausible and lead to different cases; assume (⚠ on the case) when the code or the current screens show the
answer. Each question names the cases it affects. The questions and the missing specs go with `cases` in one
stop — never a separate `clarify`. `--assume`: no questions.

**Return** `decision: cases` with `caseIds` (the internal ids `cases.mjs parse` gives), `questions`,
`missingSpecs`, `target`.

**After approval** the prompt names the snapshot and the run scope. Do not analyse the task again: setup only
when resources are missing, then tester job(s) whose `cases` together cover the run scope — split by platform
when Web and App both appear. A tester that comes back without a result for some ids gets them again (or
escalate when the environment blocks them). Close with `cases.mjs results --write` (see Close).
