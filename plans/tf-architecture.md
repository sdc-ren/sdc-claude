# Kiến trúc tf độc lập với AI agent

Trạng thái: đề xuất, chưa triển khai. Thay cho `plans/tf-multi-tool-adapter.md`.
Ngày: 2026-11-26. Đã đối chiếu với: repo `plugins/tf` (v1.26.0), tài liệu Codex và Copilot CLI, Codex CLI 0.155 cài trên máy
(bản mới nhất là 0.172.0).

## 1. Mục tiêu

- tf chạy được trên Claude Code (app desktop và CLI), Codex, Copilot CLI; sau này là Kiro, Cursor và agent chưa xuất hiện.
- Phần chung không biết mình đang chạy trên agent nào. Thêm một agent mới chỉ là thêm một thư mục adapter, không sửa phần chung.
- Cấu trúc nhỏ, mỗi phần một việc, dễ đọc, có ranh giới phụ thuộc được kiểm tra tự động.
- Không đổi hành vi tf trên Claude Code trong lúc chuyển đổi.

Ngoài phạm vi: viết lại bằng ngôn ngữ khác (giữ Node, không dependency như hiện nay), đổi quy trình PM/dev/tester/reviewer.

## 2. Nguyên tắc

1. **Phụ thuộc chỉ đi vào trong.** `hosts/*` phụ thuộc vào phần chung; phần chung không bao giờ import gì từ `hosts/`, không
   nhắc tên agent nào (`Claude`, `Codex`, `CLAUDE_PLUGIN_ROOT`, `AskUserQuestion`, `mcp__…`).
2. **Ports and adapters.** Phần chung khai báo *cổng* (interface) cho những thứ phụ thuộc agent: chạy một job, hỏi người dùng,
   biết thư mục gốc, chặn tool. Mỗi host cài đặt các cổng đó.
3. **Một lệnh `tf` duy nhất.** Prompt và skill gọi `tf <lệnh>`, không gọi `node <đường dẫn>/scripts/x.mjs`. Bỏ được 68 chỗ
   `${CLAUDE_PLUGIN_ROOT}` và vấn đề "agent này có thay biến đường dẫn không".
4. **Nội dung viết một lần.** Vai trò, quy trình lệnh, guidelines là markdown trung lập; adapter chỉ thêm frontmatter và
   đóng gói.
5. **Luật cứng nằm trong code chung**, không nằm trong prompt hay trong tính năng riêng của một agent. Hook và giới hạn tool của
   host là lớp bảo vệ thêm.
6. **Khai báo năng lực, giảm nhẹ có chủ đích.** Mỗi host khai báo nó có gì (hỏi có lựa chọn, chạy song song, JSON theo schema,
   giới hạn tool theo vai trò, hook chặn tool). Phần chung đọc khai báo này để chọn cách làm, không đoán.

## 3. Các lớp

```
┌────────────────────────────────────────────────────────────────────────────┐
│ hosts/<agent>   claude · codex · copilot · (kiro · cursor · …)             │
│   đóng gói plugin, sinh skill/agent, driver chạy job, hook glue, năng lực  │
├────────────────────────────────────────────────────────────────────────────┤
│ cli/            lệnh `tf …` — điểm vào duy nhất cho prompt, skill, hook    │
├──────────────────────────────┬─────────────────────────────────────────────┤
│ engine/                      │ content/                                    │
│ vòng PM → dispatch → job,    │ roles, commands (quy trình), guidelines,    │
│ luật cứng, dùng cổng Runtime │ template trung lập                          │
├──────────────────────────────┴─────────────────────────────────────────────┤
│ modules/        task · resources · cases · flows · env · review · tracker  │
│                 · vcs · chat · design — mỗi module độc lập theo miền       │
├────────────────────────────────────────────────────────────────────────────┤
│ core/           platform, paths, config, naming, guard-rules, ports, log   │
└────────────────────────────────────────────────────────────────────────────┘
```

Quy tắc import (kiểm tra bằng test, mục 9):
- `core` không import gì của tf.
- `modules/*` chỉ import `core` và module khác qua `index.mjs` công khai của nó. Không vòng lặp.
- `engine` import `core` và chỉ các cổng; không đọc file, không chạy tiến trình (để còn chạy được trong Workflow của Claude).
- `cli` import `core`, `modules`, `engine`.
- `hosts/<x>` import mọi thứ ở trên; không host nào import host khác.

## 4. Cấu trúc thư mục

```
plugins/tf/
  core/
    platform.mjs          ← scripts/platform.mjs (macOS/Linux/Windows)
    paths.mjs             ← thư mục dữ liệu, config workspace, migrate đường dẫn cũ (mục 7)
    config.mjs            ← đọc workspace config theo vai trò (đang nằm trong task.mjs)
    naming.mjs            ← luật tên commit/PR (đang bị chép đôi trong guard.ts)
    guard-rules.mjs       ← logic thuần của hooks/guard.ts: (job, tool, args) → allow | deny + lý do
    ports.mjs             ← định nghĩa cổng (JSDoc typedef), xem mục 5
    log.mjs
  modules/
    task/                 ← task.mjs, sources.mjs (định danh task, khóa, vòng)
    resources/            ← resources.mjs, pool.mjs, reaper.mjs, fresh.mjs
    env/                  ← serve.mjs, fastdeps.mjs, emulator.mjs, apk.mjs
    e2e/                  ← cases.mjs, flow-kit.mjs, flow-run.mjs, flow-peek.mjs, browser.mjs, annotate.mjs, webp.mjs
    review/               ← security-scan.mjs
    tracker/jira/         ← jira.mjs
    vcs/github/           ← pr-feedback.mjs
    chat/zalo/            ← zalo.mjs (cho /tf:digest)
    design/canvas/        ← canvas.mjs, canvas-runtime.js, canvas-smoke.mjs
    metrics/              ← metrics.mjs, đọc transcript qua cổng TranscriptSource
  engine/
    index.mjs             ← vòng chính (chỉ điều phối)
    dispatch.mjs          ← kiểm tra dispatch của PM: vai trò theo mode, nhóm song song, writer ≠ judge
    close.mjs             ← điều kiện đóng task (tester PASS, PR ready …)
    prompts.mjs           ← dựng prompt job (jobPrompt, context, reportLine)
    schemas.mjs           ← DISPATCH, REPORT, LEAD …
    models.mjs            ← cấp model: small | medium | large (thay 'haiku' | 'sonnet' | 'opus')
  content/
    roles/                ← pm.md, lead.md, dev.md, tester.md, reviewer.md (không frontmatter riêng của agent nào)
    roles/roles.json      ← metadata trung lập: mô tả, cấp model, quyền (read | edit | shell | network)
    commands/             ← build, qc, review, e2e, address-review, demo, digest, status, clean: quy trình của từng lệnh
                            (thay docs/orchestrator*.md, pm-*.md, reviewer-*.md, attach.md, demo.md, digest.md)
    guidelines/           ← giữ nguyên
    partials/             ← đoạn dùng chung (hỏi người dùng, mở file cho người dùng …) có bản theo năng lực host
  cli/
    tf.mjs                ← `tf <nhóm> <lệnh>`: tf task resolve, tf cases validate, tf serve start, tf guard check, tf run …
  hosts/
    _contract/            ← mô tả hợp đồng adapter + bộ test tuân thủ (mục 9)
    claude/
      host.json           ← khai báo năng lực
      build.mjs           ← sinh .claude-plugin/, skills/, agents/ từ content/
      runtime-workflow.mjs← cài cổng Runtime bằng agent()/parallel()/phase() của Workflow
      guard-module.ts     ← module hiện tại (register.tsx + guard.ts), gọi core/guard-rules
      ui/artifacts-band.tsx, integrations/artifacts/ ← phần chỉ Claude có (artifact, band UI, đặt tên phiên)
    codex/
      host.json, build.mjs ← sinh .codex-plugin/plugin.json, skills, hooks/hooks.json
      driver.mjs          ← chạy một job: codex exec --json --output-schema --sandbox …
    copilot/
      host.json, build.mjs ← sinh plugin.json (Agent Plugins), .agent.md, skills, hooks
      driver.mjs          ← copilot -p --agent … --output-format json --deny-tool …
    process/              ← runtime dùng chung cho mọi host chạy job theo tiến trình (codex, copilot, claude -p, sau này kiro, cursor)
  tests/
    core/, modules/, engine/, hosts/<x>/, boundaries.mjs, conformance.mjs
dist/                      ← sinh ra, không sửa tay (mục 8)
```

File lớn được chia khi chuyển chỗ: `engine/task-flow.js` (783 dòng) thành các file ở `engine/`; `agents/pm.md` (294 dòng)
tách phần e2e và feedback sang `content/commands/` như cách `pm-e2e.md` đang làm.

## 5. Các cổng (ports)

Viết bằng JSDoc trong `core/ports.mjs`, không cần TypeScript build cho phần chung.

| Cổng | Phần chung cần | Claude | Codex / Copilot (runtime process) |
|---|---|---|---|
| `Runtime.spawn(job)` | chạy một vai trò với prompt, cấp model, schema, cwd, quyền | `agent()` của Workflow | một tiến trình `codex exec` / `copilot -p` mỗi job |
| `Runtime.parallel(fns)` | chạy một nhóm job song song | `parallel()` | nhiều tiến trình, mỗi job một worktree; giới hạn số tiến trình |
| `Runtime.phase(title)`, `budget` | tiến độ, ngân sách | `phase()`, `budget` | ghi log; ngân sách = số lượt |
| `UserIO.ask(questions)` | hỏi có lựa chọn | `AskUserQuestion` | hỏi trong chat rồi dừng, chạy lại với câu trả lời |
| `UserIO.open(path)` | mở file cho người dùng | `mcp__ccd_host__open_in_editor` nếu có | in đường dẫn |
| `Session.title(text)` | đặt tên phiên | `mcp__ccd_session_mgmt__set_session_title` | bỏ qua |
| `TranscriptSource` | đo chi phí (metrics) | `~/.claude/projects/...` | `codex exec --json` / `--output-format json` ghi lại khi chạy |
| `GuardInput` | tool, args, job của lời gọi | sự kiện `agent.spawn` + tool call | stdin của hook + biến môi trường `TF_JOB_*` |

`job` gồm: `{ id, role, repo, prompt, tier: small|medium|large, schema, cwd, policy: { edit, shell, network, git } }`.
Host ánh xạ `tier` sang model của nó và `policy` sang cơ chế giới hạn của nó (Claude: danh sách tool của agent; Codex:
`--sandbox read-only|workspace-write`; Copilot: `--available-tools` / `--deny-tool`).

JSON theo schema: nếu host có (`codex exec --output-schema`, Workflow `schema`) thì dùng; nếu không (Copilot) thì runtime
process tách JSON từ câu trả lời cuối, kiểm tra theo `engine/schemas.mjs`, gọi lại tối đa N lần.

## 6. Guard (luật cứng ở lời gọi tool)

- Logic duy nhất: `core/guard-rules.mjs`, tách từ `hooks/guard.ts` hiện tại (đã là string check thuần, không I/O). Bỏ bản chép
  của `naming.mjs` bên trong guard.
- Nhận diện job:
  - Claude (module hiện tại): đọc dòng đầu prompt `Job J<n> · role …` khi spawn, như bây giờ.
  - Runtime process: driver gán `TF_JOB_ID`, `TF_ROLE`, `TF_WORKTREE`, `TF_THEIRS`, `TF_FLOW_LIB` cho tiến trình agent; hook
    đọc từ môi trường. Lý do: hook `PreToolUse` của Codex không có `agent_id`, nên đây là cách duy nhất dùng chung được.
- Hook dạng lệnh `tf guard hook`: đọc stdin, tự nhận dạng phương ngữ (Claude/Codex: `tool_name`, `tool_input`; Copilot:
  `toolName`, `toolArgs`), trả kết quả đúng định dạng của host (`hookSpecificOutput.permissionDecision` hoặc
  `permissionDecision`, exit 2 làm dự phòng).
- Các bước "đi ra ngoài" (commit, push, mở PR, đăng comment) vẫn đi qua lệnh `tf` có kiểm tra, nên một host không có hook vẫn
  không phá được luật chính.

## 7. Đường dẫn và dữ liệu

| Hiện tại | Đích | Cách chuyển |
|---|---|---|
| `<workspace>/.claude/task-flow.md` | `<workspace>/.tf/config.md` | `core/paths.mjs` đọc chỗ mới trước, chỗ cũ sau; `tf migrate` chuyển file |
| `~/.claude/task-flow/auth`, `reaper/` | `~/.tf/` (mọi hệ điều hành) | như trên, giữ quyền file. Không có `TF_HOME`: guard phải nhận ra đường dẫn đăng nhập chỉ từ chữ trong lệnh, nên tên thư mục phải cố định |
| `${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs` trong prompt | `tf <lệnh>` | xem mục 8 |
| `.pipeline/<slug>/` | giữ nguyên | không đổi |

## 8. Lệnh `tf` và đóng gói

- `cli/tf.mjs` là điểm vào duy nhất. Mỗi module đăng ký nhóm lệnh của nó; `tf help` liệt kê. Script cũ giữ một vỏ mỏng trong
  một bản phát hành để không gãy workspace đang dùng.
- Cách prompt tìm thấy `tf` (cần chốt, mục 11): (a) mỗi gói host mang theo `tf` và adapter thay `{{tf}}` lúc build bằng lệnh
  đúng của host đó; (b) cài `tf` toàn cục (`npm i -g`, hoặc `npx`) làm cách dùng chung cho host không có biến đường dẫn.
- `dist/<host>/` là gói hoàn chỉnh cho từng agent, sinh bởi `hosts/<host>/build.mjs`. Marketplace trỏ vào `dist/`.
  Claude, Codex và Copilot đều nhận marketplace từ repo Git, nên một repo phục vụ được cả ba.
- Workflow của Claude cần một file script tự chứa, nên `hosts/claude/build.mjs` gộp `engine/*` thành một file (tự viết gộp
  đơn giản theo thứ tự import, giữ chính sách không dependency).

## 9. Kiểm tra

- `tests/boundaries.mjs`: phân tích import, báo lỗi nếu vi phạm quy tắc ở mục 3, và nếu phần chung chứa từ cấm (`Claude`,
  `CLAUDE_`, `AskUserQuestion`, `mcp__`, `codex`, `copilot`).
- `tests/conformance.mjs`: bộ test mọi adapter phải qua, chạy với agent giả (fake CLI in ra báo cáo cố định): spawn trả về
  đúng schema, song song theo nhóm, guard chặn commit của dev, ask dừng đúng chỗ, build sinh đủ file.
- Test hiện có (`engine.mjs`, `guard.test.ts`, `platform.mjs` …) giữ nguyên ý nghĩa, chỉ đổi đường dẫn import.
- CI (`.github/workflows/tf.yml`) thêm: build mọi host, so `dist/` với bản commit, chạy conformance.
- Thử thật mỗi host trước khi công bố hỗ trợ: cài từ marketplace, chạy `/tf:status --doctor`, một `/tf:review` trên PR mẫu.

## 10. Lộ trình (mỗi bước phát hành được, không đổi hành vi Claude)

1. ✅ **Ranh giới trước, chuyển file sau**: `tests/boundaries.mjs`. Đã chặn: `core/` chỉ import `node:*` và `core/`; file
   hook-safe không import `node:*`; `core/` không nhắc tên agent (trừ danh sách cho phép có lý do); host không import host
   khác. Chỉ báo cáo (bật chặn bằng `TF_BOUNDARIES=strict`): phần chung import `hosts/`, và số lần phần chung nhắc tên agent.
   Mốc ban đầu: 41/65 file chung, 167 lần nhắc.
2. ✅ **core/**: `platform`, `paths` (đọc `.tf/` trước, đường dẫn cũ sau; mặc định vẫn là đường dẫn cũ), `config`,
   `naming`, `guard-rules`. Guard (`hooks/guard.ts`) chỉ còn phần nối sự kiện, luật nằm ở `core/guard-rules.mjs`, bỏ bản
   chép `naming`. Phần transcript của Claude chuyển sớm sang `hosts/claude/transcripts.mjs`. `scripts/platform.mjs` và
   `scripts/naming.mjs` giữ làm vỏ tương thích cho đến bước 4.
3. **cli/tf.mjs**: thêm lệnh `tf`; prompt trên Claude chuyển sang `{{tf}}` (build thay bằng
   `node ${CLAUDE_PLUGIN_ROOT}/cli/tf.mjs`), kết quả như cũ.
4. **modules/**: chuyển script vào từng miền, mỗi lần một miền, test chạy sau mỗi lần.
5. **engine/**: chia `task-flow.js`, thêm cổng Runtime, `hosts/claude/runtime-workflow.mjs`; build gộp lại một file.
   Điều kiện qua: `tests/engine.mjs` pass, một `/tf:build` thật ra cùng kết quả.
6. **content/ + hosts/claude/build.mjs**: dời nội dung, sinh lại plugin Claude vào `dist/claude`; diff so với plugin cũ
   chỉ còn phần có chủ đích. Bật `boundaries.mjs` ở chế độ chặn.
7. **hosts/process + hosts/codex**: driver, hook, đóng gói; conformance; thử thật trên Codex bản mới nhất.
8. **hosts/copilot**: tương tự.
9. Kiro, Cursor: chỉ thêm `hosts/<x>/` khi cần.

## 11. Quyết định cần chốt

1. **Cách prompt gọi `tf`**: gói host mang theo `tf` (không cần cài thêm) hay cài `tf` toàn cục qua npm (cần phát hành gói npm)?
   Đề xuất: mang theo, và hỗ trợ `tf` toàn cục làm dự phòng.
2. **`dist/` commit vào repo hay CI đẩy sang nhánh phát hành?** Commit thì marketplace dùng được ngay nhưng diff PR dài; nhánh
   phát hành gọn hơn nhưng cần thêm workflow. Đề xuất: nhánh `release` do CI sinh.
3. **Đổi tên repo/marketplace** (`sdc-claude` → tên trung lập) bây giờ hay sau khi có host thứ hai chạy được?
4. **Phần chỉ Claude có** (artifacts, canvas Claude Design, band UI): để trong `hosts/claude/` như đề xuất, hay giữ `canvas`
   là module chung vì đầu ra (demo web) không phụ thuộc agent? Đề xuất: `canvas` ở `modules/design/` (đọc file export),
   phần tìm artifact và comment claude.ai ở `hosts/claude/`.

## 12. Rủi ro

- **Workflow của Claude không cho import**: engine phải gộp thành một file; nếu gộp sai thì hỏng mọi lệnh. Giảm bằng test chạy
  đúng file đã gộp.
- **Hook của host không thừa hưởng biến môi trường** của tiến trình agent: guard theo job hỏng trên host đó. Kiểm tra trong
  conformance; dự phòng: driver ghi `<task>/jobs/.active.json` theo cwd để hook tra.
- **Agent thay đổi nhanh** (Codex đi từ 0.155, bản tháng 9, lên 0.172 ngày 24/11): adapter phải mỏng và có thử thật trước
  mỗi lần công bố hỗ trợ.
- **Chuyển đường dẫn dữ liệu đăng nhập** (`auth`): làm sai có thể lộ hoặc mất phiên đăng nhập. Chuyển bằng copy giữ quyền, không
  xóa bản cũ trong một bản phát hành.
