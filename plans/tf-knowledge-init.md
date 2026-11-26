# Kế hoạch: `/tf:init` và tri thức workspace (knowledge) cho tf

Trạng thái: giai đoạn 1 đã làm (1.31.0); giai đoạn 2 (mục 10) chưa. Ngày: 2026-11-26. Đọc cùng `plans/tf-architecture.md`.

## 1. Vấn đề

- tf cài một lần (scope user) nhưng mỗi workspace cần config riêng (`.claude/task-flow.md` hoặc `.tf/config.md`).
  Workspace mới hiện chỉ được hỏi từng mục rồi điền vào mẫu trống; tf không tự dò gì.
- tf không biết tới tri thức của workspace. Nó chỉ biết những gì mục `## Knowledge` của config ghi (chữ tự do).
  Ví dụ một workspace có bộ bản đồ đầy đủ (`features/`, `contracts/`, `erd/`, `states/`, `runtime/`, `e2e/`,
  `ledger/`, cộng lệnh sinh và lệnh contract diff), nhưng config chỉ nhắc `pipeline/` và `ledger/`, nên PM đọc lại
  code bằng codegraph cho những câu đã có câu trả lời rẻ trong bản đồ. Không có bước kiểm bản đồ cũ.
- Trên Codex, agent đọc `AGENTS.md` chứ không đọc `CLAUDE.md`, nên lời nhắc trong `CLAUDE.md` của workspace mất tác dụng.
- tf chưa từng chạy trên workspace **một repo**: worktree của task nằm trong repo (`.worktrees/<SLUG>`), và
  `.worktrees/`, `.pipeline/`, `knowledge/` hiện thành file lạ trong `git status`.

## 2. Mục tiêu

1. `/tf:init`: dò workspace, đề xuất hoặc nối config, dựng tri thức. Chạy được trên workspace mới (một hay nhiều
   repo) và trên workspace đã có config lẫn tri thức riêng — khi đó chỉ nối, không hỏi lại.
2. Tri thức thành một phần chuẩn của tf: một khuôn cho mục `## Knowledge`, kiểm bản đồ cũ trước mỗi run, PM đọc
   bản đồ trước codegraph, job chỉ nhận lát cắt của task.
3. Bộ sinh tri thức của tf là **động**: mỗi bản đồ là một provider tự xét có áp dụng cho workspace không.
   Workspace có bộ sinh riêng thì tf dùng bộ đó.

Ngoài phạm vi giai đoạn 1: các provider đọc code sâu (`contracts`, `runtime`, `states`, `erd`, `e2e`, `features`)
và contract diff — đó là giai đoạn 2 (mục 10).

## 3. Nguyên tắc

- **Không lộ dự án của ai.** Plugin không chứa tên, đường dẫn, từ khóa nghiệp vụ hay quy ước riêng của bất kỳ
  workspace nào. Chủ đề (topics) của ledger không gắn cứng (mục 6.4). `--from <đường dẫn>` chỉ đọc một file trên
  máy người chạy, không lưu lại; preset cá nhân (nếu có) nằm ở `~/.tf/presets/`, ngoài repo plugin.
- **Không sửa âm thầm.** `init` in ra đúng phần sẽ ghi và hỏi một lần; `--yes` bỏ câu hỏi, `--dry-run` chỉ in.
  Không bao giờ ghi đè mục config đã có mà không hiện diff; giữ nguyên các dòng người dùng tự viết.
- **Động theo workspace.** Một repo hay nhiều repo, monorepo, stack nào: đều đi từ kết quả dò, không giả định
  `be/fe/mobile`.
- **Workspace có bộ sinh riêng thì dùng bộ đó** (khai báo trong config). Bộ của tf là mặc định.
- **Không phụ thuộc host.** Logic là script Node trong `modules/knowledge/`; các bước hỏi người dùng đi qua
  *(host: ask)*. Chạy được trên Claude Code, Codex, Copilot.
- Không thêm dependency npm.

## 4. Chuẩn tri thức của tf (knowledge contract)

### 4.1 Thư mục

```
<workspace>/knowledge/           (đổi được bằng dòng Entry của config)
  README.md          lối vào duy nhất: bản đồ nào trả lời câu hỏi nào, thứ tự đọc, lệnh — sinh tự động
  manifest.json      bộ sinh, phiên bản, thời điểm, nguồn của từng bản đồ (sha của origin/<base>, hash file) — để kiểm cũ
  pipeline/          SỔ GHI TAY (orchestrator là người ghi duy nhất): findings.md, decisions.md, env-recipes.md,
                     review-lessons.md — không bao giờ bị bộ sinh ghi đè
  repos/             (provider repos) <key>.md mỗi repo + index.tsv
  ledger/            (provider ledger) index.tsv, by-repo/<key>.md, topics/<topic>.md
  …                  bản đồ giai đoạn 2
```

### 4.2 Mục `## Knowledge` của config (khuôn chuẩn)

```markdown
## Knowledge (PM reads the entry first; jobs get their slices; the orchestrator writes only pipeline/)
- Entry: `knowledge/README.md`
- Generate: `node <PLUGIN>/scripts/knowledge.mjs gen <root>`        (hoặc lệnh của workspace)
- Check: `node <PLUGIN>/scripts/knowledge.mjs check <root>`         (exit 1 = có bản đồ cũ; in lệnh làm mới)
- Refresh: when needed | before a run                                (mặc định when needed — xem 7.1)
- Diff: `<lệnh contract diff, có <SLUG>>`                             (tuỳ chọn — giai đoạn 2 hoặc của workspace)
- Topics: <từ khoá, cách nhau bởi dấu phẩy>                          (tuỳ chọn — xem 6.4)
- Ledger: `knowledge/pipeline/` (findings, decisions, env-recipes, review-lessons)
<các dòng tự viết của người dùng giữ nguyên bên dưới>
```

`<PLUGIN>` trong config được orchestrator thay bằng thư mục plugin (như các lệnh khác). Lệnh của workspace
(ví dụ `node scripts/knowledge/gen.mjs`) ghi nguyên văn.

### 4.3 Định dạng sổ ghi tay

Mỗi file `pipeline/*.md` là **một bảng Markdown** hoặc **danh sách dòng** (`- …`), tuỳ sổ:
- Bảng: cột nhận theo **tên tiêu đề** (so phần đầu, không phân biệt hoa thường, bỏ phần trong ngoặc — `A (đã chốt)`
  khớp `A`), không theo vị trí. Bí danh tiếng Anh và tiếng Việt: `ID`, `Date|Ngày`, `Repo`, `Severity|Mức`,
  `Summary|Mô tả|Q`, `Answer|A`, `Status|Trạng thái`, `Source|Nguồn|Task`. Thiếu cột nào thì để trống.
- Danh sách (thường là `review-lessons.md`, có khi `env-recipes.md`): mỗi dòng `- ` là một mục; tag đầu dòng
  (`[M4]`, `[be]`) được đọc thành loại / repo.
Workspace đang dùng bảng hoặc danh sách kiểu này đọc được ngay, không cần chuyển đổi.

## 5. `/tf:init` — hành vi

### 5.1 Lệnh

```
/tf:init                          dò → báo cáo → đề xuất → hỏi một lần → ghi → sinh tri thức
/tf:init --dry-run                chỉ báo cáo và in phần sẽ ghi
/tf:init --yes                    ghi không hỏi (vẫn không ghi đè mục đã có — chỉ thêm/nối)
/tf:init --from <file|workspace>  lấy cách viết các mục dùng chung từ một config có sẵn trên máy
/tf:init --refresh                chỉ sinh lại tri thức (= Generate) và in Check
```

Script: `scripts/init.mjs` (vỏ) → `modules/knowledge/init.mjs`: `detect` (JSON), `draft` (config đề xuất +
diff), `apply` (ghi). Skill `content/commands/init.md` + `docs/init.md` hướng dẫn agent chạy và hỏi người dùng.

### 5.2 Bốn trường hợp

| Workspace | Hành vi |
|---|---|
| A. Chưa có config, chưa có tri thức | Hỏi những gì không dò được (ngôn ngữ báo cáo, test policy, tracker), ghi config mới vào `.tf/config.md`, tạo `knowledge/` bằng bộ của tf |
| B. Có config, có bộ sinh riêng (`knowledge/README.md` + script sinh) | **Chỉ nối**: không hỏi lại các mục khác; thêm các dòng khuôn 4.2 vào đầu mục `## Knowledge`, **giữ nguyên các dòng tự viết**. Lệnh `Generate`/`Check`/`Diff` của workspace chỉ đề xuất từ những gì README của bộ tri thức liệt kê (không đoán cú pháp), mỗi lệnh đánh `⚠ xác nhận`; hỏi một lần trước khi ghi |
| C. Có config, chưa có tri thức | Thêm mục Knowledge theo khuôn, tạo `knowledge/` bằng bộ của tf |
| D. Có tri thức, chưa có config | Như A, nhưng mục Knowledge trỏ vào tri thức đang có |

Nếu đã có thư mục `knowledge/` mà không phải của tf (không có `manifest.json` của tf) và cũng không có bộ sinh
nhận ra được, `init` **không ghi vào đó**: đề xuất `Entry: .tf/knowledge/README.md` và hỏi.

Mọi trường hợp: báo các chỗ hở (repo chưa có `.codegraph`, thiếu `AGENTS.md` khi dùng Codex, `gh` chưa đăng nhập…)
— chỉ báo, không tự làm, trừ khi người dùng đồng ý từng việc.

### 5.3 Workspace một repo

- Bảng repos có một dòng, path `./`.
- Thêm `.worktrees/`, `.pipeline/` và các thư mục tri thức sinh tự động vào **`.git/info/exclude`** (chỉ máy này,
  không sửa `.gitignore` của dự án). `knowledge/pipeline/` không bị loại: người dùng tự chọn có commit hay không.
- Sửa `task.mjs resolve` để worktree của repo ở gốc có tên rõ ràng (`.worktrees/<SLUG>/<tên thư mục repo>`) thay vì
  chính `.worktrees/<SLUG>`, cho khớp bố cục nhiều repo. Có test riêng.

### 5.4 `--from`

Đọc một config khác. Chỉ lấy cách viết của các mục dùng chung: `Language`, `Test policy`, `Hard rules`,
`Escalation additions`, `Close-out`, `Doctor` (lệnh chung), cách viết recipe trong `Provisioning`. Không lấy
`Repos`, `Servers`, `Flows`, `Read-only zones`, `Sources`, `Knowledge` (dò lại). Mỗi mục lấy về được đánh dấu
`⚠ lấy từ <file>: xem lại`. Không ghi lại đường dẫn nguồn vào config mới.

### 5.5 Codegraph (mặc định nên có cho mọi repo)

- Dò: `codegraph` đã cài chưa; repo nào có `.codegraph/`; `codegraph status` của từng repo.
- Chưa cài → đề xuất lệnh cài và hỏi. Đã cài nhưng repo chưa index → đề xuất `codegraph init <repo>` cho từng repo,
  **chạy khi người dùng đồng ý** (một câu hỏi cho cả danh sách), chạy nền vì repo lớn mất vài phút.
- `.codegraph/` chưa bị git bỏ qua → thêm vào `.git/info/exclude` của repo đó (không sửa `.gitignore`).
- Host không có công cụ MCP của codegraph (thường là Codex, Copilot chưa cấu hình) → prompt dùng lệnh
  `codegraph explore "<…>"` (cùng kết quả). Báo cách thêm MCP nếu người dùng muốn.
- Config ghi `- Code index: codegraph` trong mục Knowledge để pre-flight biết đồng bộ index.

## 6. Bộ sinh tri thức của tf (giai đoạn 1)

### 6.1 Dò workspace (`detect`)

| Dò | Cách |
|---|---|
| Repo | `.git` ở gốc và ở thư mục con cấp 1–2 (bỏ `node_modules`, `.worktrees`, `.pipeline`) |
| Monorepo | `workspaces` trong `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `melos.yaml` |
| Nhánh gốc | `origin/HEAD`, else `main`/`develop`/`master` có trên origin |
| Stack | `package.json` (deps: next, nuxt, react, vue, @nestjs/core, express, fastify…), `pubspec.yaml`, `go.mod`, `pyproject.toml`/`requirements.txt`, `composer.json`, `pom.xml`/`build.gradle`, `Gemfile`, `Cargo.toml` |
| Package manager, lockfile, thư mục dùng lại | `package-lock.json`→npm, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `pubspec.lock` |
| Script chạy, port | `scripts.dev/start`, `.env.example` (`PORT=`), cờ `--port` trong script |
| Tài liệu sẵn có | `README*`, `CLAUDE.md`, `AGENTS.md`, `docs/`, `adr/`, `openapi*.{yaml,json}`, `swagger*` |
| Tri thức sẵn có | `knowledge/README.md`, script sinh (`scripts/knowledge*/gen*`), config có `## Knowledge` |
| Công cụ | `codegraph` (cài chưa, repo nào có `.codegraph`), `gh auth status`, Playwright trong package nào, Android SDK/AVD, các công cụ index khác theo **danh sách mở rộng được** (`modules/knowledge/tools.json`: tên, lệnh kiểm, gợi ý cài) |

Kết quả: `workspace profile` (JSON), dùng cho cả `draft` và các provider.

### 6.2 Provider và bộ chạy

`modules/knowledge/gen.mjs`: chạy các provider áp dụng được, ghi bản đồ, `manifest.json`, `README.md`.
Mỗi provider: `{ name, answers, applies(profile), sources(profile) → { key: version }, generate(ctx) → files }`.
`check`: so `sources()` hiện tại với `manifest.json` → in bản đồ cũ và lệnh `gen --only …`; exit 1 khi có bản cũ.
Nguồn đọc của repo: **git ref `origin/<base>`** (`git ls-tree`, `git show`) — không phụ thuộc checkout đang ở đâu.

### 6.3 Provider `repos` (luôn chạy)

`knowledge/repos/<key>.md` mỗi repo: stack, lệnh chạy/test/build, biến môi trường (tên, không giá trị), cây thư
mục 2 cấp kèm số file, các tài liệu sẵn có và đường dẫn, thư mục "miền nghiệp vụ" dò được (`src/modules/*`,
`lib/features/*`, `app/*`, `apps/*`, `packages/*`). `repos/index.tsv`: một dòng mỗi repo. Đủ cho workspace một
repo lẫn nhiều repo.

### 6.4 Provider `ledger` (khi có `knowledge/pipeline/`)

Cắt sổ ghi tay thành `ledger/index.tsv` (kind · id · date · repo · topics · status · summary · at),
`ledger/by-repo/<key>.md` (chỉ mục còn mở), `ledger/topics/<topic>.md`.
**Topics động**, theo thứ tự: dòng `Topics:` của config → tên các thư mục miền nghiệp vụ mà `repos` dò được →
không có thì chỉ cắt theo repo. Không có từ khóa nghiệp vụ nào gắn cứng trong plugin.

### 6.5 `README.md` sinh ra

Bảng "bản đồ nào trả lời câu hỏi nào" chỉ gồm các bản đồ đang có; thứ tự đọc khi đánh giá một task; lệnh
`Generate`/`Check`; nhắc `pipeline/` là ghi tay. Workspace có bộ sinh riêng thì tf không sinh README.

## 7. tf dùng tri thức (nối vào skill)

| Chỗ | Thay đổi |
|---|---|
| `docs/orchestrator.md` §1 bước 1 | Thiếu config → chạy luồng `init` (trường hợp A/D) thay cho hỏi tay |
| `docs/orchestrator.md` §1, bước mới 5b | Sau `fresh.mjs` (đã fetch, fast-forward và `codegraph sync`): chỉ chạy `Check` (vài giây, không sinh lại) và đưa danh sách bản đồ cũ vào args của run (`notes`) để PM biết. `Refresh: before a run` thì sinh lại luôn |
| `content/roles/pm.md` (sau khi định size) | Bản đồ cũ chỉ được sinh lại khi PM cần đọc nó: task M/L, hoặc chạm dữ liệu/ERD, contract, luồng xử lý, kiến trúc, tính năng mới → `Generate --only <bản đồ cần>` rồi đọc (script ghi vào `knowledge/`; PM vẫn không tự sửa file nào ngoài `.pipeline/<slug>/`). XS/S, đổi text, ảnh, meta, style: không sinh lại, không đọc bản đồ trừ khi một bản đồ trả lời đúng câu đang hỏi |
| `content/roles/pm.md`, `reviewer.md` | Codegraph: công cụ MCP khi có, else lệnh `codegraph explore` (host nào cũng chạy được) |
| `content/commands/clean.md` | Sau khi giải phóng các task đã merge: chỉ `Check` và báo một dòng bản đồ nào đã cũ (không sinh lại) |
| `content/roles/pm.md` Turn 1 bước 2–3 | Đọc `Entry` của Knowledge và đúng các bản đồ liên quan **trước** codegraph; codegraph để xác minh. Mỗi job: đưa lát cắt liên quan (`ledger/by-repo/<key>.md`, `ledger/topics/<t>.md`, `repos/<key>.md`) vào `reads`. `scope` nêu bản đồ đã dùng |
| `core/config.mjs` `ROLE_SECTIONS` | Thêm `Knowledge` cho `tester` (dev, reviewer đã có) |
| `content/roles/dev.md`, `reviewer.md`, `tester.md` | Một dòng: đọc lát cắt trong `Read first`, không đọc cả bộ tri thức |
| `content/roles/reviewer.md` | Có dòng `Diff` → chạy và đính kèm báo cáo vào review (giai đoạn 2 hoặc lệnh của workspace) |
| `docs/orchestrator.md` close-out | Ghi `findings/decisions/env-recipes` theo định dạng 4.3, rồi `Generate --only ledger` (hoặc lệnh của workspace). **Config đã có luật ghi sổ riêng trong `## Close-out` thì theo luật đó** |
| `docs/config-template.md` | Mục Knowledge theo khuôn 4.2 |
| `hosts/claude/doctor.mjs` | Kiểm: có Entry; `Check` chạy được và kết quả (tự thay `<PLUGIN>` trong lệnh); repo chưa có `.codegraph`; thiếu `AGENTS.md` (gợi ý) |
| `content/commands/status.md` | `--doctor` in thêm các dòng tri thức |

Engine (`engine/src/`) không đổi: lát cắt đi qua `reads` mà PM đã có sẵn.

### 7.1 Khi nào tri thức và codegraph được đồng bộ

Không có tiến trình chạy ngầm (tf đã bỏ job nền từ bản 1.16). Tách hai việc: **kiểm** (rẻ, luôn làm) và **sinh lại**
(chỉ khi task cần đọc bản đồ đó). Task đơn giản không tốn gì thêm.

| Việc | Khi nào | Chi phí |
|---|---|---|
| `codegraph sync` các checkout chính | trước mỗi run (đã có từ trước) | vài giây, tăng dần theo thay đổi; PM cần nó cả cho task nhỏ (tìm chỗ sửa) |
| `Check` bản đồ | trước mỗi run, sau `/tf:clean` | vài giây, không ghi gì; chỉ báo bản đồ nào cũ |
| Sinh lại bản đồ code | **chỉ khi PM cần đọc** bản đồ đó: task M/L, hoặc chạm dữ liệu/ERD, contract, luồng xử lý, kiến trúc, tính năng mới | chỉ các bản đồ cần và đang cũ |
| Ghi sổ + cắt lại `ledger` | cuối run có finding/quyết định/recipe mới | ms; là ghi chép của task nên luôn làm |

Không sinh lại bản đồ cho: `/tf:e2e`, `/tf:review` (đọc diff là chính), `/tf:qc` test lại bug, task XS/S đổi text,
ảnh, meta, style, cấu hình nhỏ. Chỉ khi một bản đồ trả lời đúng câu PM đang hỏi thì đọc nó (kể cả bản cũ, kèm cảnh
báo "cũ từ <ngày>", và xác minh bằng codegraph).
Workspace muốn luôn mới thì đặt `Refresh: before a run`.

Bản đồ code đọc từ `origin/<base>`, nên thay đổi của một task chỉ vào bản đồ khi PR đã merge.

## 8. Thay đổi file (dự kiến)

Mới: `modules/knowledge/{detect,source,gen,init,draft,tools.json}.mjs|json`,
`modules/knowledge/providers/{repos,ledger}.mjs`, `scripts/knowledge.mjs`, `scripts/init.mjs` (vỏ),
`content/commands/init.md`, `docs/init.md`, `tests/knowledge.mjs`, `tests/init.mjs`.
Sửa: `docs/orchestrator.md`, `docs/config-template.md`, `content/roles/{pm,dev,reviewer,tester}.md`,
`core/config.mjs` (+ test `config` của `tests/task.mjs`), `modules/task/task.mjs` (repo ở gốc),
`hosts/claude/doctor.mjs`, `content/commands/status.md`, `content/commands/clean.md`,
`cli/commands.mjs` (`knowledge`, `init`), README (lệnh mới), CHANGELOG, version **1.31.0**.
Sinh lại: `skills/`, `agents/`, `skills/init/agents/openai.yaml`.

## 9. Kiểm tra

- `tests/knowledge.mjs`: dò trên workspace giả (một repo; ba repo; monorepo pnpm), provider `repos`, `ledger` với
  bảng tiêu đề tiếng Anh và tiếng Việt, topics từ config / từ thư mục / không có, `check` báo cũ khi sha đổi hoặc
  sổ ghi tay đổi, không đụng `pipeline/`.
- `tests/init.mjs`: bốn trường hợp A–D, cộng thư mục `knowledge/` lạ; B giữ nguyên dòng tự viết và chỉ đổi mục Knowledge; `--dry-run` không ghi;
  `--yes`; `--from` chỉ lấy mục dùng chung; một repo → `.git/info/exclude`, worktree path mới.
- Ranh giới: `modules/knowledge` chỉ import `core/` và `modules/`. Test: plugin không chứa đường dẫn home tuyệt đối.
- Không có prompt nào nhắc tên công cụ của host (test sẵn có).
- **Thử thật trên máy bạn** (bạn chạy, hoặc tôi chạy với `--dry-run` rồi đưa bạn xem): workspace nhiều repo có tri
  thức riêng → chỉ mục Knowledge đổi; một repo mới → config + `knowledge/` hợp lý.
- Đo: `/tf:status --metrics` trước/sau trên task tương đương (token của PM turn 1).

## 10. Giai đoạn 2 (phác thảo, lên plan riêng sau)

Provider đọc code từ `origin/<base>`, JS/TS và Flutter trước: `contracts` (route Express/NestJS/Next ↔ lời gọi
fetch/axios/dio, OpenAPI, socket), `runtime` (cron, queue, webhook), `states` (enum và chỗ ghi), `erd` (từ schema
Prisma/Sequelize/TypeORM; đọc DB sống là tuỳ chọn), `e2e` (flow của tf, testid/identifier), `features` (chỉ khi
code có tag). `diff --task <SLUG>`. So với bộ tri thức của một workspace thật để biết còn thiếu gì — code của
workspace đó không đi vào plugin.

## 11. Rủi ro

- **Dò sai stack/port** → config đề xuất sai. Giảm: mọi giá trị dò được ghi kèm nguồn, chỗ không chắc đánh `⚠`.
- **Workspace lớn** → dò chậm. Giảm: đọc qua `git ls-tree`, giới hạn độ sâu, bỏ thư mục sinh.
- **Sửa mục Knowledge của config người dùng viết tay.** Giảm: chỉ thêm các dòng khuôn ở đầu mục, giữ nguyên mọi dòng
  cũ; luôn hiện diff; có `--dry-run`.
- **PM đọc bản đồ nhưng bản đồ cũ** → kế hoạch sai. Giảm: bước 5b báo bản đồ nào cũ; PM sinh lại trước khi đọc khi
  task cần; đọc bản cũ thì kèm cảnh báo; bản đồ là điểm xuất phát, codegraph xác minh.
- **PM phân loại sai task "nhỏ"** → bỏ qua bản đồ lẽ ra cần. Giảm: luật gắn với điều task chạm (dữ liệu, contract,
  luồng), không chỉ với size; plan check của reviewer (M/L) vẫn đọc plan với ticket.
- **Workspace một repo chưa từng được chạy trọn** → có thể còn chỗ hở khác ngoài worktree path (codegraph có index
  `.worktrees/` không, `serve`/`pool` với repo ở gốc). Giảm: test `resolve`/`fresh`/`resources` với repo ở gốc; ghi
  rõ là mới hỗ trợ.

## 12. Quyết định đang theo mặc định (đổi được trước khi làm)

| Điểm | Mặc định |
|---|---|
| Thư mục tri thức | `knowledge/` ở gốc workspace |
| Config mới | `.tf/config.md` (config cũ giữ đường dẫn của nó) |
| `init` sửa config | hiện diff và hỏi một lần; `--yes`, `--dry-run` |
| Bộ sinh riêng của workspace | dùng bộ của workspace |
| Bản đồ cũ | chỉ kiểm trước run; sinh lại khi PM cần đọc (task lớn / chạm dữ liệu, contract, luồng, kiến trúc); `Refresh: before a run` để luôn sinh lại |
| Codegraph | đề xuất cài và index mọi repo chưa có; chạy khi người dùng đồng ý |
| Commit `knowledge/` | sinh tự động: không (một repo thì vào `.git/info/exclude`); `pipeline/`: người dùng chọn |
| Stack giai đoạn 2 | JS/TS (Express, NestJS, Next) và Flutter |
