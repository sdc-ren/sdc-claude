# E2E testing (Playwright web, Android app)

How end-to-end checks are written and run, so a later round can re-run them instead of re-driving the
UI by hand. Workspace specifics (targets, accounts, viewports, devices, screenshot budget) live in the
workspace config; this file is the shared standard.

## One flow = one case

- One file per case, named by the case's internal id (`flows/TC1.mjs`; `cases.mjs` derives it from the ticket/QC
  case number when there is one).
- A flow is self-contained and re-runnable: it creates the data it needs (API first, UI only when the
  UI itself is under test) with a unique suffix per run, and never depends on another flow's leftovers.
- Assert the acceptance criterion as the user sees it (text, state, navigation), plus the API/DB effect
  when the criterion is about data. A flow that only clicks and screenshots proves nothing.
- Keep flows short: setup → the action under test → assertions. Shared steps (login, seeding, waiting for a
  background job) live in the workspace library `.pipeline/_lib/` (`FLOW_LIB`), listed in its `README.md` —
  written once, imported by every task's flows, extended but never changed incompatibly.

## Evidence that points at the bug

A failed case must be readable without the flow: the screenshot shows where it fails, the way QC marks one.
- Name the element in the assertion: `expect(cond, 'Nút bị khoá, BTC không biết vì sao', { at: page.getByRole('button',
  { name: 'Tiếp theo' }), expected: 'có câu lỗi dưới ô', actual: 'không có câu lỗi' })`. On failure the flow kit
  shoots the screen with that element scrolled into view, and the runner draws a red box around it and the
  label next to it (`scripts/annotate.mjs`); a small element also gets a close-up.
- Several wrong places on one screen: `await mark(at, label)` for each, then `shot('<name>', { caption, crop })`.
- `label` is one short sentence in the writing language, may use "→" for the consequence. `expected` / `actual`
  become the Mong muốn / Hiện tại columns of the ticket comment.
- Android: `at` is a `find()` selector (`{ id }`, `{ text }`, `{ desc }`), its uiautomator bounds are the box.
- Case ids are internal ids (`[A-Za-z0-9_-]`): QC ids with spaces or accents stay in `cases.md` headings only.

## Selectors (most stable first)

Look at the real page before writing them (`flow-peek.mjs`), and at the page dump a failed step leaves
(`<case>-fail-<step>.page.txt`) before changing them — a guessed selector costs a full run to disprove.

1. Test ids / accessibility ids (`data-testid`, Flutter `Semantics(identifier:)` → `resource-id`).
2. Role + accessible name (`getByRole('button', { name: 'Lưu' })`), label, placeholder.
3. Visible text, only when it is part of the requirement.
4. CSS/XPath — last resort, never on generated class names or DOM position.
Missing a stable id on an element the flow needs → note it for the dev/app team; do not build on
fragile selectors silently.

## Waiting and timing

- Wait for the app, never the clock: auto-waiting actions, polling assertions, the API response that
  carries the data (`waitApi`), the screen's ready element plus loading indicators gone (`ready`,
  `gotoReady`). No fixed sleeps, no `networkidle` (slow and unreliable on SPAs). Android: `waitFor`.
- The timeout (≈15 s) is a ceiling, not a delay: a ready screen continues at once; only a stuck step
  waits it out and fails. A slow step is a finding, not a reason to raise the timeout.
- No retries to make a flow green. A flaky flow is fixed (selector, wait, data) or reported as flaky.

## Evidence

- `after` screenshot for every case; `before` only when the change is visual. Name `<case>-<state>`.
- A visual case passes only when before and after differ in the region the requirement names, and the
  after state is asserted by measurement. Two identical screenshots are not evidence of a fix.
- Failure screenshot is automatic. Playwright trace only on request (`TRACE=1`) when a failure is not
  clear from the screenshot and error — tracing slows every action, so normal runs skip it.
- WebP for stored images. Respect the workspace screenshot budget and viewports.
- Never capture or log secrets: mask tokens/passwords, no real personal data in screenshots; logs with
  credentials are never uploaded (upload a sanitized summary instead).

## Environment

- Each task drives its own browser/emulator; never a shared browser profile, someone else's tab, or a
  device already running. Close what you start.
- Target (`local` task ports vs a shared dev/staging URL) is explicit for every run and recorded with
  the result. Writes on shared environments only inside test data you created.
- Console errors and failed requests (5xx) during a flow are reported with the result even when the
  assertion passes.

## Results

- Per case: `PASS`, `Failed — BUG: <impact in one sentence>`, or `Not tested — <reason>`; evidence
  attached. Environment problems are `Not tested` / blocked, never `Failed`.
- A flow broken by an intended UI change is fixed and re-run; it is not an app bug.
