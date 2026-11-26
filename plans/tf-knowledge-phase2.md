# Kế hoạch: tri thức workspace, giai đoạn 2 — bản đồ đọc code và contract diff

Trạng thái: 2a đã làm (1.32.0: contracts, diff); 2b chưa. Ngày: 2026-11-26. Nối tiếp `plans/tf-knowledge-init.md` (giai đoạn 1, đã có trong 1.31.x).

## 1. Mục tiêu

Bộ sinh của tf hiện có `repos` và `ledger`. Giai đoạn 2 thêm các bản đồ đọc **code** để PM trả lời nhanh câu
"task này chạm những gì" mà không phải lần từng file:

| Bản đồ | Trả lời |
|---|---|
| `contracts` | Endpoint (HTTP, socket) nằm ở repo nào, ai gọi nó (web, app, service khác), quyền và validator, OpenAPI có chưa; lời gọi không khớp route nào |
| `runtime` | Những đường chạy không qua request người dùng: cron, queue/worker, webhook, event/pub-sub, socket emit |
| `states` | Các enum trạng thái và chỗ ghi từng giá trị |
| `erd` | Bảng/model, cột, quan hệ, và service nào dùng model đó |
| `e2e` | Flow e2e đã có (tf), selector nào được định nghĩa ở đâu và flow nào dùng nó |
| `features` | Vai trò → màn hình → endpoint, **chỉ khi** code có tag khai báo (không suy đoán) |

Cộng **`diff`**: contract của một task so với nhánh gốc (route thêm/xoá/đổi quyền, lời gọi bị gãy) cho reviewer.

Ngoài phạm vi: stack khác JS/TS và Dart/Flutter (Laravel, Django, Spring, Go…) — kiến trúc cho phép thêm sau;
đọc DB sống cho ERD (tuỳ chọn, để sau); bản đồ cho từng framework hiếm gặp.

## 2. Nguyên tắc (giữ từ giai đoạn 1)

- **Động:** provider chỉ chạy khi nhận ra thứ nó đọc được; không nhận ra framework nào thì **bỏ qua bản đồ và ghi
  lý do** trong README, không sinh bản đồ rỗng hay đoán.
- **Không dependency npm:** đọc bằng quét văn bản (regex + bộ tách tham số có cân ngoặc, bỏ qua chuỗi/comment),
  không dùng parser AST. Chấp nhận sót; **mỗi bản đồ ghi rõ độ phủ** (đã nhận ra bao nhiêu file/route, bỏ qua gì).
- **Đọc từ `origin/<base>`**, như `repos`. `diff` đọc thêm worktree của task (gồm thay đổi chưa commit).
- **Không gắn với dự án nào:** không tên, tag, prefix hay từ khóa nghiệp vụ cứng. Quy ước riêng của workspace (tag
  feature, prefix API, tên thư mục) khai báo trong config hoặc được dò.
- **Workspace có bộ sinh riêng** (như trường hợp B) không bị ảnh hưởng: bản đồ của tf chỉ chạy khi config trỏ tới
  bộ của tf.
- Mỗi bản đồ là một thư mục: `README.md` (đọc gì, độ phủ), `index.tsv` (grep được), và các trang chia nhỏ theo
  miền/repo để job chỉ nhận lát cắt.

## 3. Kiến trúc

```
modules/knowledge/
  source.mjs          + grep(pattern, globs) trên git ref (git grep) và trên worktree; đọc có giới hạn kích thước
  scan.mjs            (mới) tiện ích quét: dòng của vị trí, tách tham số có cân ngoặc, bỏ chuỗi/comment, chuẩn hoá path
                      (`:id`, `{id}`, `${x}`, `[id]`, `<int:id>` → `*`), so khớp path theo segment
  frameworks/         (mới) bộ nhận diện + trích xuất theo framework — một file mỗi framework, cùng một hợp đồng:
    express.mjs  nestjs.mjs  next.mjs  nuxt.mjs  fastify.mjs        → routes
    http-client.mjs  dart-http.mjs                                   → lời gọi (fetch/axios/ofetch/$fetch/useFetch; dio/http)
    openapi.mjs  socketio.mjs                                        → spec; emit/on
    prisma.mjs  sequelize.mjs  typeorm.mjs  mongoose.mjs  sql-migrations.mjs   → models
    schedule.mjs (node-cron, @nestjs/schedule, agenda)  bullmq.mjs  events.mjs (EventEmitter, @OnEvent, redis pub/sub)
    enums.mjs (TS enum, `as const`, Prisma/Sequelize ENUM, Dart enum)
    selectors.mjs (data-testid, getByTestId, Flutter Semantics identifier / Key)
  providers/
    repos.mjs  ledger.mjs                                            (đã có)
    contracts.mjs  runtime.mjs  states.mjs  erd.mjs  e2e.mjs  features.mjs   (mới)
  diff.mjs            (mới) contract diff của một task
```

Hợp đồng framework: `{ name, detect(repo) → bool (từ dependency/file), extract(reader) → items[] }`, mỗi item có
`at: <file>:<line>`. Provider gom item của mọi framework nhận ra được trong mọi repo, nối chéo repo (route ↔ lời
gọi, model ↔ service), rồi ghi trang. Thêm framework mới = thêm một file trong `frameworks/` + một test fixture.

## 4. Từng bản đồ

### 4.1 `contracts` (khi có ít nhất một repo có route)

- **Route** (repo server): Express (`router.get/post/...`, `app.use(prefix, router)` theo import — đi từ file vào và
  cộng prefix), NestJS (`@Controller(prefix)` + `@Get/@Post…`, `@UseGuards`, `@Roles`, DTO validator), Next.js
  (`app/**/route.ts` export `GET/POST…`, `pages/api/**`), Nuxt/Nitro (`server/api/**.[method].ts`), Fastify
  (`fastify.get(...)`, `route({method,url})`). Mỗi route: method, path chuẩn hoá, handler, guard/middleware (tên),
  validator (tên), `at`.
- **Lời gọi** (repo client, có thể cùng repo): JS/TS `fetch`, `axios.*`, `$fetch`, `ofetch`, `useFetch`, client tự
  bọc (`api.get(...)` — dò các biến được tạo từ `axios.create`/`ofetch.create`), chuỗi path literal hoặc template;
  Dart `dio.get/post…`, `http.get(Uri...)`. Mỗi lời gọi: method (nếu biết), path, hàm bao quanh, `at`.
- **Prefix API**: dò từ `baseURL`/`prefix` trong code và `app.setGlobalPrefix`; config có thể ép bằng
  `- API prefix: /api/v1` trong `## Knowledge`.
- **Khớp**: theo segment, tham số là `*`. Kết quả: route ↔ danh sách người gọi (repo, file:line, hàm).
- **OpenAPI** (`openapi*.yaml|json`, `swagger*`): route nào có/không trong spec.
- **Socket** (socket.io): `emit('x')` ↔ `on('x')` giữa server và client.
- Trang: `contracts/README.md` (độ phủ: route theo framework, lời gọi khớp/không khớp), `contracts/index.tsv`
  (method · path · repo · at · guards · validators · callers · openapi), `contracts/by-domain/<miền>.md` (miền =
  segment đầu sau prefix), `contracts/orphans.md` (lời gọi không có route; route không ai gọi — chỉ liệt kê, không
  kết luận), `contracts/socket.md`.

### 4.2 `runtime` (khi nhận ra ít nhất một loại)

Cron (`node-cron` `schedule(...)`, `@Cron(...)`, agenda `every/define`), queue (BullMQ `new Queue('x')`,
`new Worker('x', …)`, `.add('job')`), webhook (route có `webhook|callback|ipn|notify` trong path — cờ, không kết
luận), event (`emitter.emit/on`, `@OnEvent`, `redis.publish/subscribe`), socket emit phía server. Trang:
`runtime/async.md` (theo loại, mỗi mục: tên, lịch/queue, handler, `at`) + `runtime/index.tsv`.

### 4.3 `states` (khi có enum)

Enum TS (`enum X {}`), object hằng `as const` có khoá IN HOA, `DataTypes.ENUM(...)`, Prisma `enum`, Dart `enum`.
Chỉ giữ enum trông như trạng thái (tên có `status|state|phase|stage|step|type`) — **ngưỡng cấu hình được**
(`- State enums: <regex>`), mặc định như trên. Chỗ ghi: các dòng gán/so sánh giá trị đó ngoài file test
(`status: 'x'`, `.status = X.Y`, `update({ status: … })`) — giới hạn số dòng mỗi giá trị. Trang:
`states/README.md` + `states/<enum>.md`.

### 4.4 `erd` (khi có schema/model)

Prisma `schema.prisma` (model, trường, `@relation`), Sequelize (`define`, `Model.init`, `belongsTo/hasMany/…`),
TypeORM (`@Entity`, `@Column`, `@ManyToOne/…`), Mongoose (`new Schema({...})`, `ref:`), migration SQL
(`CREATE TABLE`, `REFERENCES`) khi không có ORM. Nối model ↔ service dùng nó (tên model xuất hiện trong file
service/controller). Trang: `erd/README.md` (bảng · số cột · quan hệ) + `erd/<bảng>.md` + `erd/index.tsv`.
Đọc DB sống: không làm ở giai đoạn này.

### 4.5 `e2e` (khi có flow của tf hoặc selector trong code)

Flow của tf: `.pipeline/*/flows/*.mjs` + `flows.json` (platform, kết quả cuối) và `.pipeline/_regression/`.
Selector dùng trong flow (`getByTestId`, `[data-testid=…]`, `{ id: … }`) ↔ selector định nghĩa trong code
(`data-testid=` trong web, `Semantics(identifier:`/`Key('…')` trong Flutter). Trang: `e2e/flows.md` (flow nào cho
màn hình/case nào — dùng lại làm case hồi quy), `e2e/selectors.md` (selector → định nghĩa ở đâu → flow nào dùng;
selector flow dùng mà code không còn → cảnh báo). Nguồn là thư mục làm việc (`.pipeline/`), không phải git: bản
đồ cũ khi hash các file flow đổi.

### 4.6 `features` (chỉ khi code có tag)

Workspace khai báo tag trong config: `- Feature tags: @screen, @api, @role` (không có dòng này → dò các tag JSDoc
phổ biến trong comment ngay trên route/màn hình: `@feature`, `@screen`, `@role`). Không có tag nào → **không sinh**,
README nói vì sao. Trang: `features/README.md` + `features/<vai trò hoặc miền>.md` (màn hình → endpoint → `at`).

### 4.7 `diff --task <SLUG>`

`node <PLUGIN>/scripts/knowledge.mjs diff <root> --task <SLUG> [--out <file>]`:
- Mỗi repo có worktree của task (`.worktrees/<SLUG>/<repo>`): phía task = worktree (gồm thay đổi chưa commit, file
  mới chưa track); phía gốc = **merge-base** của HEAD worktree với `origin/<base>` (như PR so sánh — route mà nhánh
  gốc thêm sau khi task tách không bị tính là "bị xoá"). Repo không có worktree: hai phía là `origin/<base>`.
- Báo: route thêm / xoá / đổi path / đổi guard / đổi validator; lời gọi thêm/xoá; **lời gọi bị gãy** (route bị
  xoá/đổi mà client — bản của task hoặc nhánh gốc — vẫn gọi); orphan mới; socket event thêm/xoá.
- Worktree của task tìm theo đúng quy tắc của `task.mjs resolve` (`repoMap`: `.worktrees/<SLUG>/<thư mục repo>`, kể
  cả repo ở gốc) — dùng lại hàm đó, không tự đoán đường dẫn.
- Exit: 0 không đổi contract · 3 có đổi (đọc báo cáo) · 4 có lời gọi gãy / orphan mới.
- `init` thêm dòng `- Diff:` này khi workspace dùng bộ của tf và có bản đồ `contracts`.

## 5. Thay đổi ngoài `modules/knowledge`

| Chỗ | Thay đổi |
|---|---|
| `modules/knowledge/gen.mjs` | đăng ký provider mới; `--out <dir>` (sinh ra thư mục khác — để so sánh mà không ghi vào workspace); thời gian từng provider trong `manifest.json` |
| README sinh ra (`knowledge/README.md`) | thêm hàng cho bản đồ mới; thứ tự đọc khi đánh giá task: features → contracts → states + runtime → erd → ledger → e2e → xác minh bằng codegraph |
| `modules/knowledge/init.mjs` | dòng `Diff` cho bộ của tf khi có `contracts`; báo bản đồ nào áp dụng được |
| `core/config.mjs` `KNOWLEDGE_KEYS` | thêm `API prefix`, `API clients`, `State enums`, `Feature tags` (đều tuỳ chọn) |
| `content/roles/reviewer.md` | dòng `Diff` (đã có từ giai đoạn 1): thay `<root>` bằng Workspace root của job, `<SLUG>` bằng task |
| `content/roles/pm.md` | không đổi luật (đã có từ giai đoạn 1); thêm ví dụ lát cắt: `contracts/by-domain/<miền>.md`, `erd/<bảng>.md` |
| `content/roles/tester.md` | flow cũ của màn hình bị chạm = ứng viên case hồi quy (`e2e/flows.md`); kiểm `e2e/selectors.md` trước khi đổi selector |
| `docs/config-template.md` | các dòng tuỳ chọn mới |
| `cli/commands.mjs` | không đổi (`knowledge` đã có; `diff` là lệnh con) |

## 6. Kiểm tra

- **Fixture cho từng framework** (`tests/fixtures/knowledge/<framework>/`, nhỏ, viết tay): Express (router lồng +
  prefix), NestJS (controller + guard), Next (app router + pages/api), Nuxt server/api, Fastify, client fetch/axios/
  ofetch/dio, OpenAPI, socket.io, BullMQ, node-cron/@Cron, EventEmitter/@OnEvent, Prisma, Sequelize, TypeORM,
  Mongoose, SQL migration, enum TS/Dart, data-testid/Semantics. Mỗi fixture có kết quả mong đợi (route, khớp, bảng…).
- **Workspace giả nhiều repo** (dựng trong test): server + web + app; kiểm khớp route ↔ lời gọi chéo repo, orphan,
  độ phủ ghi trong README, bản đồ bị bỏ qua có lý do.
- **`diff`**: route thêm/xoá/đổi guard trong worktree, thay đổi chưa commit, nhánh gốc tiến lên sau khi tách (không
  báo nhầm "bị xoá"), exit 0/3/4.
- **Hiệu năng**: workspace 3 repo cỡ vừa < 30 giây cho `gen` đủ bộ; ghi thời gian từng provider.
- **So với một workspace thật có bộ sinh riêng** (chỉ đọc, sinh vào thư mục tạm bằng `--out`): đếm route, bảng,
  enum, flow so với bản đồ của chính workspace đó; ghi chênh lệch vào PR (chỉ con số, không nội dung). Code của
  workspace đó không đi vào plugin.
- **CRLF**: mọi fixture có thêm một bản xuống dòng CRLF (như checkout trên Windows); `reader.read` chuẩn hoá `\r\n`
  trước khi quét, số dòng `at` vẫn đúng.
- Ranh giới (`modules/knowledge` chỉ import `core/` và `modules/`), quét quyền riêng tư (không tên/đường dẫn cá nhân),
  host build `--check`. Fixture không chứa chuỗi giống secret (gitleaks).

## 7. Chia PR

| PR | Nội dung | Version |
|---|---|---|
| 2a | `scan.mjs`, `source.grep`, framework route/client/openapi/socket, `contracts`, `diff`, `--out`, dòng `Diff` trong init | 1.32.0 |
| 2b | `runtime`, `states`, `erd`, `e2e`, `features`, README thứ tự đọc đầy đủ, tester | 1.33.0 |

2a trước vì contract và diff đem lại nhiều nhất cho PM và reviewer (task chạm API là loại hay sót tác động nhất).

## 8. Rủi ro

- **Quét văn bản sót hoặc sai** (route ghép động, path dựng từ biến, decorator tự viết). Giảm: độ phủ ghi trong
  README; mục "không khớp" chỉ liệt kê, không kết luận; PM vẫn xác minh bằng codegraph; fixture cho từng mẫu.
- **False positive ở `states`** (enum không phải trạng thái). Giảm: lọc theo tên, cấu hình được, giới hạn số mục.
- **Repo lớn chậm.** Giảm: `git grep` thay vì đọc mọi file; chỉ đọc file khớp mẫu; giới hạn kích thước file;
  provider chỉ chạy khi `check` báo cũ và PM cần (giai đoạn 1).
- **Monorepo** (nhiều app trong một repo): framework nhận diện theo `package.json` gần nhất của file, không theo
  gốc repo. Có fixture monorepo.
- **Client tự bọc API** khó nhận ra. Giảm: dò biến tạo từ `axios.create`/`ofetch.create`/`Dio(...)`; config có
  thể khai báo thêm tên hàm gọi (`- API clients: apiFetch, http`).

## 9. Câu hỏi để chốt (mặc định trong ngoặc)

1. Hai PR (2a contracts + diff, 2b phần còn lại) hay một PR? (hai PR)
2. `states` mặc định chỉ lấy enum có tên kiểu trạng thái, hay mọi enum? (kiểu trạng thái, cấu hình được)
3. `erd` chỉ từ schema/model/migration, chưa đọc DB sống? (đúng)
4. So sánh với workspace thật của bạn bằng `--out` vào thư mục tạm, chỉ đưa con số vào PR? (đúng)
