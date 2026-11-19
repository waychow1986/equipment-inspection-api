# 设备巡检记录服务技术方案

> 依据：已确认的意图（version 2，`confirmed: true`）、规格 `spec.md`（FR-001～FR-029、IQA-001～IQA-021，PQ-001～PQ-004 已有人工答案）、项目宪章、平台运行参考（依赖声明 v3、部署声明 v2、Agent Pod、独立测试契约）。
> 本方案只回答“怎么做”，不改变规格中已确认的产品行为。

## 技术上下文（Technical Context）

| 项 | 选择 |
|---|---|
| 仓库现状 | 新项目，仓库只有 `README.md` 与交付文档；没有既有代码、技术基线或客户技术偏好记录 |
| 语言 / 运行时 | TypeScript 5.x，Node.js 22 LTS（Agent Pod 预装 Node 22） |
| Web 框架 | Fastify 5（内置 JSON Schema 校验、pino 结构化日志、可关闭请求自动日志） |
| 持久化 | PostgreSQL（推荐 16，最低 14），驱动 `pg` 8.x |
| 测试 | Vitest（单元 / 集成 / 功能三类，分别对应开发者验证类别） |
| 静态检查 | `tsc --noEmit` + ESLint（typescript-eslint） |
| 交付形态 | 单个容器化 HTTP 服务 `inspection-api`，对外暴露，端口 8080 |
| 外部依赖 | 仅 1 个：`inspection-db`（PostgreSQL），推荐平台以容器运行 |
| 目标规模 | 规格未设定性能/容量指标；按单门店网络少量并发、单设备记录量不大设计（意图假设） |

## 治理与技术约束

| 约束来源 | 内容 | 设计响应 |
|---|---|---|
| 宪章·产品与架构 | 最简单的满足需求的架构；记录重大决策 | 单服务 + 单数据库，无缓存、无消息队列；重大决策见 TD 表 |
| 宪章·安全与隐私 | 凭据保留在服务端；least privilege；验证输入；不记录 secret 或客户内容 | 令牌只以 SHA-256 摘要存储；角色最小权限；Fastify Schema 校验；日志白名单字段（见“安全”“可观测性”） |
| 宪章·测试与质量 | 外部集成用真实测试服务做 contract/integration/E2E；Mock 不作验收证据 | 集成与功能测试连接平台注入的 `dev` PostgreSQL 实例；`realInstance.dev/test` 均为 true |
| 意图·客户约束 | 交付一个后端服务，不做前端 | 只提供 HTTP JSON API |
| 规格 PQ-003 | 无统一身份系统；令牌—持有人—角色对应关系由运维作为机密配置提供；删除令牌并让服务重新加载即收回；不做账号管理接口 | TD-004：令牌登记表（仅存摘要）由运维维护，服务每次请求实时查表，删除即生效 |
| 平台·候选部署 | 镜像非 root（数字 UID）；网络默认拒绝；对外服务经网关 TLS 终止后以 HTTP 转发 | Dockerfile `USER 10001`；服务只访问已声明的 `inspection-db` |
| 平台·依赖注入 | 应用只从 `AIDH_DEP_*` 读取依赖配置；只实现 `AIDH_DEP_{N}_AUTH_MODE` 所示的认证方式 | 配置模块只读这些变量；仅支持 `credential`，其他值启动失败 |
| 平台·验证 | 开发者命令在注入 `dev` 实例变量的 Pod 中执行，不设计“无依赖”模式 | 集成/功能测试直接连接 `dev` 实例，用独立 schema 隔离 |

## 架构概览（Architecture）

```
 巡检员 / 管理人员的调用方
          │ HTTPS（平台网关终止 TLS）
          ▼
 ┌──────────────────────────── inspection-api（Node 22 / Fastify） ───────────────────────────┐
 │  routes ──► auth（Bearer 令牌 → SHA-256 → 查 access_token） ──► 角色校验 ──► 输入校验      │
 │     │                                                                                      │
 │     └──► InspectionService ──► InspectionRepository ──► pg Pool ───────────────┐           │
 │  logger（pino，字段白名单）   migrations（启动时执行，advisory lock）           │           │
 └──────────────────────────────────────────────────────────────────────────────┼───────────┘
                                                                                ▼
                                        inspection-db（PostgreSQL，schema `inspection`）
                                          ├─ inspection_record（只增不改，触发器禁止 UPDATE/DELETE）
                                          ├─ access_token（令牌摘要 → 持有人标识、角色）
                                          └─ schema_migration
 运维 ──► token-admin CLI（同一镜像内，`node dist/cli/token-admin.js`）──► access_token
```

- 无状态服务：所有业务状态在 PostgreSQL；服务进程重启不丢失任何已确认的记录（FR-022）。
- 每次请求实时查令牌登记表，没有进程内令牌缓存；“让服务重新加载”在本方案中无需额外动作，删除/新增令牌的事务提交后下一次请求即生效（FR-027、FR-028，比“重新加载后生效”更及时，行为上包含之）。

## 技术决策与替代方案

| 决策 ID | 选择 | 理由 | 已考虑替代方案 | 来源 |
|---|---|---|---|---|
| TD-001 | TypeScript + Node 22 + Fastify 5 | 无既有基线；Agent Pod 预装 Node 22；Fastify 自带 Schema 校验与 pino 日志、可关闭自动请求日志，便于满足日志隐私 | Java/Spring Boot（更重）；Python/FastAPI（同样可行，但日志与校验需要更多拼装）；.NET（可行，无优势） | 宪章·最简架构 |
| TD-002 | PostgreSQL 作为唯一持久化（推荐平台以容器运行 `postgres:16-alpine`，带持久卷） | 部署声明不支持为服务挂卷，服务容器本地文件在重新部署后丢失，必须有外部持久化才能满足 AC-07；PostgreSQL 开源、事务与 fsync 保证“接受即已保存” | 容器内 SQLite 文件（重新部署丢数据，否决）；Azure Database for PostgreSQL（`cloud`，需 IaC，平台以容器即可满足，增加成本与复杂度；客户可在依赖任务中改选） | FR-001、FR-022、AC-07 |
| TD-003 | 记录不可变：数据库触发器拒绝 `UPDATE`/`DELETE`；API 不提供修改/删除端点 | 双重保证 FR-021；即便代码缺陷也无法改写历史 | 仅靠应用层不提供端点（防护较弱） | FR-021、Q5 |
| TD-004 | “机密配置”实现为 PostgreSQL 中的令牌登记表 `inspection.access_token`：只存令牌的 SHA-256 摘要、持有人标识、角色；运维用镜像内的 `token-admin` CLI（或等价 SQL）维护；服务每次请求实时查表 | ① 令牌明文不落库、不进镜像、不进仓库；② 删除即对下一次请求生效，满足 FR-027 且无需重启；③ 测试环境中独立测试可凭注入的 `test` 实例连接信息以运维身份登记/删除测试令牌，从而可独立执行 IQA-021（平台不提供在测试运行中修改项目机密的能力）；④ 服务不暴露任何令牌管理端点（FR-029） | A. 令牌清单作为应用机密 `AIDH_SECRET_ACCESS_TOKENS` 注入，修改后重新部署才生效：独立测试无法在一次运行中修改项目机密，IQA-021 无法执行；生产收回需重新部署。B. Azure Key Vault + 定时重载：引入云依赖与身份配置，复杂度高 | PQ-003、FR-017、FR-027～FR-029、IQA-021 |
| TD-005 | 身份凭据走 `Authorization: Bearer <token>` 请求头 | 标准做法；不出现在 URL，避免进入网关/访问日志 | 自定义请求头；查询参数（会进 URL，否决） | FR-023、FR-026 |
| TD-006 | 查询用 `GET /v1/inspection-records?deviceId=...`，不把设备标识放进路径；服务关闭 Fastify 自动请求日志，只记录路由模板 | 缺少设备标识时能作为“输入不符合要求”返回 400 并指明字段（FR-016），而不是路由 404；日志只写路由模板，不含设备标识 | `GET /v1/devices/{deviceId}/inspection-records`（缺设备时只能 404，且路径含客户内容） | FR-016、FR-024、FR-025 |
| TD-007 | 巡检结论在接口中用代码值 `NORMAL`（正常）/ `ABNORMAL`（异常），其他取值一律拒绝 | 机器可读、与语言无关；在契约中给出与“正常/异常”的一一对应 | 直接使用中文字面值“正常/异常”（可行，但对调用方编码不友好） | FR-001、FR-006、PQ-002 |
| TD-008 | 提交时间由数据库在插入时 `clock_timestamp()` 生成（UTC，毫秒精度输出）；排序 `submitted_at DESC, seq DESC` | 时间来源唯一、不受请求内容影响；同一毫秒内的并列由单调递增序号决定，“后提交的在前”稳定 | 应用进程时间（多实例时钟可能不一致） | FR-004、FR-013 |
| TD-009 | 记录标识为服务生成的 UUID v4（`crypto.randomUUID()`），内部另有自增 `seq` 主键 | 对外标识不可猜测、不泄露数量；`seq` 用于稳定排序 | 只用自增 ID（可枚举） | FR-001、不变量 3 |
| TD-010 | 数据库迁移：服务启动时在 `pg_advisory_lock` 下按序执行仓库内的 SQL 迁移，只做向前、可叠加的变更 | 单服务、无额外迁移工具；锁保证多副本同时启动时只执行一次 | node-pg-migrate / Flyway（额外依赖，收益小） | FR-022 |
| TD-011 | 集成/功能测试在 `dev` 实例中为每次运行创建独立 schema（`inspection_t_<随机>`），结束时删除 | 记录表禁止删除，独立 schema 避免测试数据积累且互不干扰；仍是真实 PostgreSQL | 共享 schema + 唯一前缀（数据只增不减，长期积累） | 宪章·测试与质量 |
| TD-012 | 不设请求速率限制与分页 | 规格未要求；意图假设单设备记录量不大、第一版不分页 | 加分页（改变 FR-014 行为，否决） | FR-014 |

## 领域与数据模型

### 巡检记录 `inspection.inspection_record`

| 列 | 类型 | 约束 | 对应规格 |
|---|---|---|---|
| `seq` | `bigint GENERATED ALWAYS AS IDENTITY` | 主键；仅内部排序用，不对外 | 不变量 3、FR-013 |
| `record_id` | `uuid` | `NOT NULL UNIQUE`；服务生成 | 记录标识，FR-001 |
| `device_id` | `text` | `NOT NULL`，1～128 字符（去除首尾空白后） | 设备标识，FR-005、FR-011 |
| `store_id` | `text` | `NOT NULL`，1～128 字符（去除首尾空白后） | 门店标识，FR-006 |
| `conclusion` | `text` | `NOT NULL CHECK (conclusion IN ('NORMAL','ABNORMAL'))` | 巡检结论，FR-006 |
| `note` | `text` | 可空；≤2000 字符；未填写或仅空白时为 `NULL` | 备注，FR-007 |
| `inspector_id` | `text` | `NOT NULL`；来自令牌登记表的持有人标识 | 提交的巡检员，FR-003 |
| `submitted_at` | `timestamptz` | `NOT NULL DEFAULT clock_timestamp()`；插入语句不提供此列 | 提交时间，FR-004 |

- 索引：`inspection_record_device_idx ON (device_id, submitted_at DESC, seq DESC)`，支撑按设备查询与排序。
- 触发器 `inspection_record_immutable`：`BEFORE UPDATE OR DELETE ... FOR EACH ROW` 抛出异常（SQLSTATE `P0001`，消息固定为 `inspection_record is append-only`，不含任何数据）；`TRUNCATE` 由语句级触发器同样拒绝。
- 不存在外键：服务不维护设备/门店档案（FR-008、Q3）。

### 令牌登记表 `inspection.access_token`（“机密配置”的落地形式，TD-004）

| 列 | 类型 | 约束 |
|---|---|---|
| `token_sha256` | `char(64)` | 主键；`CHECK (token_sha256 ~ '^[0-9a-f]{64}$')`；令牌 UTF-8 字节的 SHA-256 小写十六进制 |
| `holder_id` | `text` | `NOT NULL`，1～128 字符；非秘密的持有人标识（姓名或工号） |
| `role` | `text` | `NOT NULL CHECK (role IN ('inspector','manager'))` |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` |

- 一个令牌只对应一位持有人和一种角色（规格假设）；同一人需要两种能力时登记两个令牌（PQ-004）。
- 令牌明文从不写入数据库；摘要不可逆推令牌（令牌要求 ≥32 个字符的高熵随机串，`token-admin` 生成时为 32 字节随机数的 base64url）。
- 删除一行即收回该令牌；已有巡检记录只引用 `holder_id` 文本，不受影响（FR-027）。

### 迁移登记 `inspection.schema_migration`

`version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()`。迁移文件 `migrations/NNN_<name>.sql`，第一版只有 `001_initial.sql`（创建 schema、上述三张表、索引、触发器）。

### 输入规范化规则（规格假设“空值视同缺少”）

- `deviceId`、`storeId`、`note`、查询参数 `deviceId`：若为字符串，先去除首尾空白；去除后为空串视同缺少。保存与查询都使用去除首尾空白后的值，保证“同一台设备”按同一标识判定。
- 非字符串类型（数字、对象、数组、`null`）视为“输入不符合要求”，原因 `INVALID_TYPE`（`note` 为 `null` 时视同未填写）。
- 长度上限：`deviceId`、`storeId` 128 字符；`note` 2000 字符；超出时原因 `TOO_LONG`。这是“验证输入”（宪章）的保护性上限，正常巡检数据不会触及。
- 请求体中未定义的字段（如 `inspector`、`submittedAt`、`inspectorId`）被忽略，不导致拒绝，也不影响记录（FR-003、FR-004、IQA-003）。

## Component 边界与项目结构

Coding 会创建或修改的路径（写路径清单）：

- `package.json`、`package-lock.json`、`tsconfig.json`、`tsconfig.build.json`、`eslint.config.mjs`、`vitest.config.ts`、`.dockerignore`、`.gitignore`、`.nvmrc`
- `Dockerfile`
- `README.md`
- `src/`
  - `src/server.ts`：进程入口（读取配置、执行迁移、启动 HTTP、优雅退出）
  - `src/app.ts`：构建 Fastify 实例（路由、错误处理、钩子），供测试直接注入
  - `src/config.ts`：从环境变量读取并校验配置（见“配置”）
  - `src/logger.ts`：pino 配置（级别标签、字段白名单、序列化器）
  - `src/db/pool.ts`：`pg` 连接池（TLS 模式、超时）
  - `src/db/migrate.ts`：迁移执行器
  - `src/auth/token-registry.ts`：令牌摘要计算与登记表查询
  - `src/auth/authenticate.ts`：Bearer 解析、401/403 判定的 Fastify 钩子
  - `src/inspections/routes.ts`：两条业务路由与 Schema
  - `src/inspections/validation.ts`：输入规范化与字段级错误
  - `src/inspections/repository.ts`：插入与按设备查询
  - `src/http/errors.ts`：统一错误响应体与错误处理器
  - `src/health/routes.ts`：`/healthz`
  - `src/cli/token-admin.ts`：运维令牌登记工具
- `migrations/`：`migrations/001_initial.sql`
- `test/`
  - `test/unit/`：校验、令牌解析、错误映射、日志序列化器（不连库）
  - `test/integration/`：连接 `dev` PostgreSQL 的仓储、迁移、触发器、令牌登记表测试
  - `test/functional/`：启动真实服务进程（localhost）+ `dev` PostgreSQL 的端到端 HTTP 测试，含重启与日志隐私检查
  - `test/support/`：测试 schema 创建/清理、随机令牌与合成数据生成、进程启动与日志捕获工具
- 以下由技术方案产出，Coding 不修改：`docs/dependencies.json`、`docs/deployment.json`、`deploy/probes/inspection-db.sh`

```
.
├── Dockerfile
├── package.json / package-lock.json / tsconfig*.json / eslint.config.mjs / vitest.config.ts
├── migrations/001_initial.sql
├── src/{server,app,config,logger}.ts
├── src/{db,auth,inspections,http,health,cli}/
├── test/{unit,integration,functional,support}/
├── docs/{dependencies.json,deployment.json}
└── deploy/probes/inspection-db.sh
```

模块边界：路由层只做协议转换；`authenticate` 钩子在路由处理前完成身份与角色判定；`validation` 只做纯函数校验；`repository` 是唯一访问 `inspection_record` 的位置，`token-registry` 是唯一访问 `access_token` 的位置（CLI 复用它）。

## 数据流、状态、并发与生命周期

### 提交（FR-001～FR-009、FR-017、FR-019）

1. 读取 `Authorization`；缺失、非 `Bearer` 格式、令牌为空或长度 >512 → 401 `UNAUTHENTICATED`。
2. 计算令牌 SHA-256，`SELECT holder_id, role FROM inspection.access_token WHERE token_sha256 = $1`；无行 → 401。
3. 角色不是 `inspector` → 403 `FORBIDDEN`（先于输入校验，管理人员令牌无论请求体如何都得到“无权执行该操作”）。
4. 解析 JSON 请求体（`Content-Type: application/json`，≤16 KiB）；非 JSON / 解析失败 / 不是对象 → 400，字段 `body`。
5. 规范化与校验 `deviceId`、`storeId`、`conclusion`、`note`，汇总全部字段错误 → 400。
6. 单条 `INSERT ... RETURNING`（参数化），`record_id` 由服务生成，`inspector_id` 取自第 2 步的 `holder_id`，`submitted_at` 由数据库生成；事务提交后才返回 201。
7. 第 3～5 步任何拒绝都不触达 `INSERT`，因此不产生记录（不变量 1）。

### 查询（FR-010～FR-016、FR-017、FR-018、FR-020）

1～2. 同提交。3. 角色不是 `manager` → 403。4. 校验查询参数 `deviceId`（缺失/空白/重复出现/超长 → 400）。
5. `SELECT ... WHERE device_id = $1 ORDER BY submitted_at DESC, seq DESC`，一次返回全部（FR-014）；无行返回 `records: []`（FR-012）。不按门店过滤（FR-015）。

### 并发与一致性

- 每次提交是独立的单行插入，无读后写、无唯一业务键，重复内容也各自成行（FR-009）；无需应用层锁。
- 查询使用默认 `READ COMMITTED`；201 返回前已提交，之后的查询必然可见（“被接受的提交一定已被保存”）。
- 令牌删除与请求并发：已通过第 2 步的请求按其开始时的身份完成；删除事务提交后的请求一律 401。

### 生命周期

- 启动：读取并校验配置 → 建立连接池 → 获取 advisory lock 执行迁移 → 监听 `0.0.0.0:8080` → 记录 `service started`（不含配置值）。
- 停止：收到 `SIGTERM`/`SIGINT` → 停止接受新连接，等待在途请求（最多 10 s）→ 关闭连接池 → 退出码 0。
- 未捕获异常 / 未处理的 Promise 拒绝：以 `fatal` 级别记录（只含错误名与错误码）后退出码 1，由平台重启。

## Interface 与契约（Contract）

基础约定：

- 基础地址：候选环境为平台给出的对外 HTTPS 地址（`AIDH_SERVICE_INSPECTION_API_URL`）；所有业务路径以 `/v1` 开头。
- 编码：请求与响应均为 `application/json; charset=utf-8`。
- 身份：业务接口必须携带 `Authorization: Bearer <访问令牌>`。
- 每个响应带 `X-Request-Id`（服务生成的 UUID，仅用于关联日志，不含业务内容）。
- 时间格式：ISO 8601 UTC，毫秒精度，例如 `2026-11-19T08:30:12.345Z`。
- 任何响应都不回显令牌、`Authorization` 头或请求体原文（FR-026）。

### POST /v1/inspection-records — 提交巡检结果（INT-001）

允许角色：`inspector`。

请求体：

```json
{
  "deviceId": "ASSET-000123",
  "storeId": "STORE-021",
  "conclusion": "ABNORMAL",
  "note": "压缩机异响"
}
```

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `deviceId` | string | 是 | 去首尾空白后 1～128 字符 |
| `storeId` | string | 是 | 去首尾空白后 1～128 字符 |
| `conclusion` | string | 是 | 只接受 `NORMAL`（正常）或 `ABNORMAL`（异常），区分大小写 |
| `note` | string \| null | 否 | ≤2000 字符；缺省、`null`、空白 → 记录中为 `null` |
| 其他字段 | 任意 | — | 忽略（例如 `inspectorId`、`submittedAt` 不影响记录） |

成功 `201 Created`，响应头 `Location: /v1/inspection-records?deviceId=<URL 编码的设备标识>`，响应体为保存的记录：

```json
{
  "recordId": "6f1c2a0e-6b0a-4f4b-9a63-0f3b8e0f2c11",
  "deviceId": "ASSET-000123",
  "storeId": "STORE-021",
  "conclusion": "ABNORMAL",
  "note": "压缩机异响",
  "inspectorId": "zhang.san",
  "submittedAt": "2026-11-19T08:30:12.345Z"
}
```

### GET /v1/inspection-records?deviceId={设备标识} — 查询某台设备的历史记录（INT-002）

允许角色：`manager`。查询参数 `deviceId` 必填（去首尾空白后 1～128 字符，只能出现一次）；不需要也不接受门店条件（其他查询参数忽略）。

成功 `200 OK`（无记录时同样 200）：

```json
{
  "deviceId": "ASSET-000123",
  "records": [
    { "recordId": "…", "deviceId": "ASSET-000123", "storeId": "STORE-021", "conclusion": "ABNORMAL",
      "note": null, "inspectorId": "li.si", "submittedAt": "2026-11-19T09:00:00.001Z" },
    { "recordId": "…", "deviceId": "ASSET-000123", "storeId": "STORE-021", "conclusion": "NORMAL",
      "note": "正常", "inspectorId": "zhang.san", "submittedAt": "2026-11-19T08:30:12.345Z" }
  ]
}
```

- `records` 按 `submittedAt` 从新到旧；`submittedAt` 相同时后插入的在前。
- 每条记录的字段集合固定为上例七个字段；`note` 未填写时为 `null`。

### 错误响应（FR-025、FR-026）

统一格式：

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "输入不符合要求",
             "fields": [ { "field": "deviceId", "reason": "REQUIRED" } ] } }
```

| HTTP | `error.code` | `message` | 场景 | 规格 |
|---|---|---|---|---|
| 401 | `UNAUTHENTICATED` | 未识别身份 | 缺少/格式错误的 `Authorization`；令牌不在登记表（含已收回）。附 `WWW-Authenticate: Bearer` | FR-017、FR-027 |
| 403 | `FORBIDDEN` | 无权执行该操作 | `manager` 提交；`inspector` 查询 | FR-018～FR-020 |
| 400 | `VALIDATION_FAILED` | 输入不符合要求 | 字段错误，`fields[]` 列出每个不符合要求的字段 | FR-005、FR-006、FR-016 |
| 404 | `NOT_FOUND` | 资源不存在 | 未定义的路径/方法（包括任何 `PUT`/`PATCH`/`DELETE` 记录的尝试） | FR-021、FR-029 |
| 413 | `VALIDATION_FAILED` | 输入不符合要求 | 请求体超过 16 KiB，`fields: [{ "field": "body", "reason": "TOO_LARGE" }]` | 宪章·验证输入 |
| 503 | `SERVICE_UNAVAILABLE` | 服务暂不可用 | 数据库不可达/超时；未产生记录 | — |
| 500 | `INTERNAL_ERROR` | 服务内部错误 | 其他未预期错误 | — |

- 判定顺序固定：身份（401）→ 角色（403）→ 输入（400）。
- `fields[].field` 取值：`deviceId`、`storeId`、`conclusion`、`note`、`body`；`fields[].reason` 取值：`REQUIRED`（缺少或空白）、`INVALID_TYPE`、`INVALID_VALUE`（结论不在允许值内）、`TOO_LONG`、`MULTIPLE_VALUES`（查询参数重复）、`MALFORMED`（请求体不是 JSON 对象）、`TOO_LARGE`。
- 错误响应不包含请求中的任何取值。

### GET /healthz — 健康检查（平台使用，无需身份）

数据库 `SELECT 1` 在 2 s 内成功 → `200 {"status":"ok"}`；否则 `503 {"status":"unavailable"}`。不返回版本、配置或任何业务数据。

### 令牌登记契约（运维 / 测试环境，非服务接口）

令牌登记表是运维与服务之间的契约（FR-029：服务不提供令牌管理的 HTTP 入口）。

- 摘要：`token_sha256 = lower(hex(SHA-256(UTF-8(token))))`。
- 登记：`INSERT INTO inspection.access_token (token_sha256, holder_id, role) VALUES ($1, $2, $3) ON CONFLICT (token_sha256) DO UPDATE SET holder_id = EXCLUDED.holder_id, role = EXCLUDED.role`。
- 收回：`DELETE FROM inspection.access_token WHERE token_sha256 = $1`（或按 `holder_id` + `role`）。提交后立即生效，无需重启（等价于规格中的“删除并重新加载”）。
- 服务启动时只保证表存在，不自动写入任何令牌。
- `token-admin` CLI（镜像内 `node dist/cli/token-admin.js`，读取与服务相同的 `AIDH_DEP_INSPECTION_DB_*` 变量）：
  - `issue --holder <id> --role inspector|manager`：生成 32 字节随机令牌，登记摘要，并把令牌明文只写到标准输出一次（交给运维转交持有人，不进入日志）。
  - `register --holder <id> --role inspector|manager`：从标准输入读取运维提供的令牌（拒绝少于 32 个字符的令牌），登记摘要。
  - `revoke --holder <id> [--role <role>]` 或 `revoke --token-stdin`：删除对应登记。
  - `list`：列出 `holder_id`、`role`、`created_at` 与摘要前 8 位，不输出令牌。
  - 参数里从不出现令牌明文（避免进入 shell 历史和进程列表）。

### 外部依赖契约

唯一外部依赖 `inspection-db` 为标准 PostgreSQL 协议（≥14），使用上文的 schema；`realInstance.dev` 与 `realInstance.test` 均为 true，不需要模拟服务。

## 安全、隐私、身份与 Secret

### 身份与授权（FR-017～FR-020、FR-027～FR-029）

| 调用者 | `POST /v1/inspection-records` | `GET /v1/inspection-records` |
|---|---|---|
| 登记表中 `role = inspector` 的令牌 | 允许 | 403 |
| 登记表中 `role = manager` 的令牌 | 403 | 允许（任意门店的任意设备） |
| 无令牌 / 令牌不在登记表 / 已删除 | 401 | 401 |

- 令牌比较通过摘要等值查询完成，不在应用中比较明文；令牌为高熵随机串，摘要不加盐即可抵抗离线猜测。
- 记录中的巡检员只取登记表的 `holder_id`；请求体中的同类字段被忽略（FR-003）。
- 服务没有任何管理端点；令牌只能由能连接数据库的运维（或测试环境中的独立测试）维护（FR-029）。

### Secret 处理

| Secret | 来源 | 进入应用的方式 | 保护措施 |
|---|---|---|---|
| 数据库密码 | 平台为容器生成（`generatedSecrets: db-password`）或客户提供 | `AIDH_DEP_INSPECTION_DB_PASSWORD`（机密来源注入） | 只在建立连接池时使用；不记录、不回显；配置错误信息只写变量名 |
| 访问令牌 | 运维发放；测试令牌为项目机密 `test` 值 | 调用方的 `Authorization` 头 | 服务只保存摘要；日志、响应、错误中都不出现 |
| 测试令牌 I1、I2、M1、X | 项目机密 `QA_INSPECTOR_1_TOKEN`、`QA_INSPECTOR_2_TOKEN`、`QA_MANAGER_TOKEN`、`QA_INVALID_TOKEN`（仅 `test` 环境） | 独立测试环境的 `AIDH_SECRET_*` | 独立测试只把摘要写入测试实例的登记表；脚本、证据中不写原文 |

- 宪章“支持时使用 managed identity”：平台以容器运行的 PostgreSQL 不支持托管身份，只能用 `credential`；若客户改选支持 Entra ID 的托管 PostgreSQL，需要另行修订本方案（应用当前只实现 `credential`，遇到其他 `AUTH_MODE` 启动失败并给出明确错误）。
- Coding 自测不需要任何人提供的令牌：测试在运行时生成随机令牌并登记到本次运行的独立 schema，结束后随 schema 删除。

### 输入与传输

- 所有 SQL 使用参数化查询；schema 名称只来自配置并在启动时以 `^[a-z_][a-z0-9_]{0,62}$` 校验后加引号使用。
- 请求体上限 16 KiB；只接受 `application/json`。
- 对外 TLS 由平台网关终止；数据库连接 TLS 由 `AIDH_DEP_INSPECTION_DB_SSLMODE` 决定（容器形态为 `disable`，集群内网络；客户提供的托管实例应为 `require` 或 `verify-full`）。
- 容器以 UID 10001 运行，只读业务代码，无写本地文件需求。

### 日志隐私（FR-023、FR-024、AC-08）

- 关闭 Fastify 自动请求日志（`disableRequestLogging: true`），由 `onResponse` 钩子写一条访问日志，字段白名单：`time`、`level`、`msg`、`event`、`requestId`、`method`、`route`（路由模板，如 `/v1/inspection-records`，**不是**带查询串的 URL）、`statusCode`、`durationMs`、`errorCode`（如 `VALIDATION_FAILED`）。
- 永不记录：请求 URL/查询串、请求头、请求体、响应体、令牌及其摘要、持有人标识、设备/门店标识、备注、结论、记录标识、数据库连接信息。
- 错误序列化器只输出 `errName`（如 `DatabaseError`）与 `errCode`（如 PostgreSQL SQLSTATE `57P01`），不输出 `message`、`detail`、`stack`（PostgreSQL 的 `detail` 会包含行数据；JSON 解析错误信息会包含请求体片段）。
- pino `redact` 额外屏蔽 `req.headers.authorization`、`headers.authorization`、`*.password`、`*.token` 作为纵深防御。
- 功能测试在全部场景执行后，对捕获的服务标准输出/错误逐一检索本次使用的令牌、持有人标识、设备/门店标识与备注标记，要求零命中（对应 IQA-019 的开发者侧证据）。

## 配置、可观测性与运维

### 配置（全部来自环境变量）

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `AIDH_DEP_INSPECTION_DB_ADDRESS` | 是 | — | `主机名:端口` |
| `AIDH_DEP_INSPECTION_DB_DATABASE` | 是 | — | 数据库名 |
| `AIDH_DEP_INSPECTION_DB_USERNAME` | 是 | — | 数据库用户 |
| `AIDH_DEP_INSPECTION_DB_PASSWORD` | 是 | — | 机密 |
| `AIDH_DEP_INSPECTION_DB_SSLMODE` | 否 | `disable` | `disable` / `require` / `verify-full` |
| `AIDH_DEP_INSPECTION_DB_AUTH_MODE` | 否 | `credential` | 只支持 `credential` |
| `PORT` | 否 | `8080` | 监听端口 |
| `LOG_LEVEL` | 否 | `info` | `debug`/`info`/`warn`/`error` |
| `INSPECTION_DB_SCHEMA` | 否 | `inspection` | 仅测试覆盖为独立 schema |
| `DB_POOL_MAX` | 否 | `10` | 连接池上限 |

缺少必需变量或取值非法时，进程以 `fatal` 记录“配置无效”及变量**名**后退出码 1。

### 日志与错误识别

- 输出：标准输出，每行一个 JSON 对象（pino），`level` 以文本标签输出（`formatters.level` → `"level":"error"`），消息字段 `msg`。
- 级别约定：`info` 启动、迁移完成、访问日志（2xx/4xx）；`warn` 数据库瞬时错误后恢复；`error` 5xx、数据库不可达、迁移失败；`fatal` 配置无效、未捕获异常。4xx 是调用方问题，不记为 `error`。
- `docs/deployment.json` 的 `operations.errorLogRules`：
  - `app-error-log`（`kind: structured`，`level` ∈ `error`/`fatal`，`messageField: msg`，severity high）：发现 5xx、数据库与迁移故障、崩溃。
  - `node-uncaught-error`（`kind: pattern`，severity high）：日志器初始化前的非 JSON 崩溃输出（如 `Error: Cannot find module …`）。
- 指标与追踪：规格无要求，第一版不引入；`X-Request-Id` 用于把调用方报障与访问日志关联。

## SLO、限制、扩缩容、重试与恢复

- 规格没有批准的时限、容量或可用率指标，本方案不设 SLO。设计目标（非承诺）：单次提交/查询 p95 < 200 ms（单库、单索引查询）。
- 限制：请求体 16 KiB；字段长度见契约；查询不分页（FR-014）。
- 扩缩容：服务无状态，可水平扩展；第一版部署 1 副本。迁移在 advisory lock 下执行，多副本同时启动安全。
- 数据库超时：连接超时 5 s，语句超时 `statement_timeout = 5000ms`；连接池错误时返回 503，不自动重试写入（避免重复插入；调用方收到 503 可重新提交，最坏情况与“再提交一条”语义一致）。
- 启动时数据库不可达：每 2 s 重试连接，最长 60 s，仍失败则 `fatal` 退出，由平台重启。
- 恢复：数据库数据在持久卷上；服务重启后直接可查（FR-022）。数据库备份由依赖实例的提供方负责（容器形态为持久卷；生产建议客户提供带备份的托管实例）。

## 部署拓扑、迁移、Rollout 与 Rollback

- 部署声明 `docs/deployment.json`：服务 `inspection-api`，构建上下文 `.`，构建文件 `Dockerfile`，端口 8080，`healthPath: /healthz`，`exposed: true`。
- 镜像：多阶段构建，`node:22-bookworm-slim`；构建阶段 `npm ci` + `npm run build`；运行阶段 `npm ci --omit=dev`，复制 `dist/` 与 `migrations/`，`USER 10001`，`CMD ["node","dist/server.js"]`。
- 网络：入站只到 8080（经网关）；出站只到 `inspection-db` 的目标地址。
- 迁移：服务启动时执行，只做向前、可叠加变更（新增表/列/索引），不在同一版本中删除或重命名旧结构。
- Rollout：平台以候选 SHA 构建镜像并部署；健康检查 `/healthz` 通过即就绪（数据库可达且迁移完成后才开始监听）。
- Rollback：重新部署上一版本镜像；因为迁移只做可叠加变更，旧版本可在新 schema 上运行；不回滚数据，巡检记录不会因回滚丢失。

## 测试设计

### 开发者验证命令（Coding 写入当前 Feature 目录 `runtime/deployment.json`）

```json
{
  "developerSetupCommands": ["npm ci"],
  "developerValidationCommands": {
    "staticAnalysis": ["npm run lint", "npm run typecheck"],
    "build": ["npm run build"],
    "developerTests": ["npm run test:unit"],
    "integrationTests": ["npm run test:integration"],
    "functionalTests": ["npm run test:functional"]
  }
}
```

- `test:integration` 与 `test:functional` 直接使用注入的 `AIDH_DEP_INSPECTION_DB_*`（`dev` 实例）；变量缺失时测试**失败**而不是跳过。
- 每条命令都必须实际执行到测试；Vitest 配置 `passWithNoTests: false`。

### 测试分层与覆盖

| 层 | 内容 | 覆盖 |
|---|---|---|
| 单元 | 输入规范化与字段错误（缺失、空白、类型、超长、结论非法、额外字段忽略）；Bearer 解析；错误码映射与判定顺序；日志序列化器不输出 `message/detail/stack` | FR-005～FR-008、FR-016、FR-025、FR-026 |
| 集成（真实 PostgreSQL） | 迁移幂等与并发启动（两次 `migrate` 并行）；插入后可查；排序与并列；按设备隔离；`UPDATE`/`DELETE`/`TRUNCATE` 被触发器拒绝；令牌摘要登记、查找、删除后不可识别；`token-admin` 的 issue/register/revoke/list 不输出令牌 | FR-001、FR-009～FR-013、FR-021、FR-027、FR-028 |
| 功能（真实进程 + 真实 PostgreSQL） | 在 localhost 启动 `node dist/server.js`，按规格 IQA-001～IQA-017、IQA-020、IQA-021 的操作与预期逐条执行（令牌在运行时生成并登记）；IQA-018：停止进程后重新启动，比对 D1～D5 查询结果完全一致；IQA-019：捕获进程全部 stdout/stderr，检索令牌、持有人标识、设备/门店/备注标记零命中；IQA-021：删除 I2 登记后不重启即验证 401 与记录不变 | AC-01～AC-08 |

### 独立测试（QA）需要的环境条件

| 场景 | 条件与做法 |
|---|---|
| 全部 | 服务地址 `AIDH_SERVICE_INSPECTION_API_URL`；测试令牌来自项目机密 `AIDH_SECRET_QA_INSPECTOR_1_TOKEN`、`AIDH_SECRET_QA_INSPECTOR_2_TOKEN`、`AIDH_SECRET_QA_MANAGER_TOKEN`、`AIDH_SECRET_QA_INVALID_TOKEN`（前置条件）。开始时以运维身份连接 `test` 实例（`AIDH_DEP_INSPECTION_DB_*`），按“令牌登记契约”登记 I1、I2（`inspector`）、M1（`manager`）的摘要，持有人标识自定（如带运行标记的 `qa-inspector-1-<run>`），并确保 X 的摘要不在登记表中 |
| IQA-018 | 在 `runtime/qa-phases.json` 中声明 `redeployBefore: ["IQA-018"]`，前后阶段通过 `QA_STATE_DIR` 传递重启前的查询结果（不含令牌） |
| IQA-021 | 以运维身份从 `test` 实例登记表删除 I2 的摘要（提交即生效，即规格中的“删除并重新加载”），之后按场景操作 |
| IQA-019 | 需要服务在测试期间的全部日志；平台参考中未写明独立测试取得候选服务日志的方式，见“开放决策” OD-1 |

## 验证环境责任矩阵（Verification Environment）

| 验证类型 | 责任阶段 | 环境来源 | 依赖/凭据 | Coding 证据 | 下游结果 |
|---|---|---|---|---|---|
| 静态检查 | Coding / 候选验证 | Agent Pod 同镜像 | 无 | `npm run lint`、`npm run typecheck` 通过 | 候选验证记录 |
| 构建 | Coding / 候选验证；ACR Tasks | Agent Pod；ACR | 无 | `npm run build` 通过；Dockerfile 非 root | 候选镜像 |
| 单元测试 | Coding / 候选验证 | Agent Pod | 无 | `npm run test:unit` 报告 | 候选验证记录 |
| 集成测试（contract/integration） | Coding / 候选验证 | Agent Pod + `inspection-db` `dev` 实例 | `AIDH_DEP_INSPECTION_DB_*`（dev） | `npm run test:integration` 报告 | 候选验证记录 |
| 功能 / 端到端 | Coding / 候选验证 | Agent Pod localhost 进程 + `dev` 实例 | 同上；令牌运行时生成 | `npm run test:functional` 报告（含日志零命中检查） | 候选验证记录 |
| 依赖探测 | 依赖与机密任务 | 平台隔离探测环境 | 本依赖的 `AIDH_DEP_INSPECTION_DB_*` | — | 探测结果（可达、认证、2 条约束） |
| 候选部署健康 | 平台 | `cand-{deliveryShortId}` | `test` 实例 | — | `/healthz` 200 |
| 独立验收 IQA-001～IQA-021 | 独立测试 | QA Pod → 候选 HTTPS 地址 + `test` 实例 | `AIDH_SECRET_QA_*`（test）、`AIDH_DEP_INSPECTION_DB_*`（test） | — | `qa-run.sh` 结果与证据 |
| 运行期错误发现 | 平台 | 候选运行日志 | — | — | 按 `errorLogRules` 生成问题报告 |

## 快速验证指南（Quickstart）

在 Agent Pod 中（已注入 `dev` 实例变量）：

```bash
npm ci && npm run build
INSPECTION_DB_SCHEMA=inspection_dev_$RANDOM PORT=8080 node dist/server.js &
# 登记两个令牌（令牌明文只出现在本终端的标准输出）
INSPECTION_DB_SCHEMA=... node dist/cli/token-admin.js issue --holder demo-inspector --role inspector
INSPECTION_DB_SCHEMA=... node dist/cli/token-admin.js issue --holder demo-manager --role manager
curl -s -X POST localhost:8080/v1/inspection-records -H "Authorization: Bearer $INSPECTOR" \
  -H 'Content-Type: application/json' -d '{"deviceId":"D-1","storeId":"S-1","conclusion":"NORMAL"}'
curl -s "localhost:8080/v1/inspection-records?deviceId=D-1" -H "Authorization: Bearer $MANAGER"
```

预期：提交返回 201 与记录；查询返回 1 条记录；用巡检员令牌查询返回 403。

## 支持 Runbook

| 情况 | 处理 |
|---|---|
| 新增巡检员/管理人员 | 运维在可连接数据库的环境运行 `token-admin issue --holder <工号> --role <角色>`，把输出的令牌通过安全渠道交给本人 |
| 收回权限 | `token-admin revoke --holder <工号> [--role <角色>]`；提交后立即生效，无需重启；该人已有记录不受影响 |
| 令牌疑似泄露 | 先 `revoke`，再 `issue` 新令牌 |
| `/healthz` 503 或 `app-error-log` 报告 `errCode` 为 `08xxx`/`57P0x` | 检查 `inspection-db` 实例状态与网络；服务恢复连接后自动可用 |
| 启动退出且日志“配置无效” | 日志中给出缺失/非法的变量名，在依赖与机密任务中补齐 |
| `errCode` 为 `P0001` 且来自记录表 | 有代码试图修改/删除记录，属缺陷，记录未被改变 |
| 回滚 | 重新部署上一版本镜像；无需数据操作 |

## 开放决策

本阶段的技术决定已全部作出，无阻塞事项。以下事项随本方案确认：

- **OD-1（非阻塞，提示独立测试与平台）**：IQA-019 要求取得候选服务在测试期间的全部日志，平台参考资料未写明独立测试取得候选服务日志的途径。本方案的应对：服务日志只写标准输出、字段白名单（见“日志隐私”），功能测试在开发者侧对完整进程输出做零命中检查，平台按 `errorLogRules` 扫描运行日志。独立测试若无法取得日志，按独立测试契约记为测试缺口，由 G4 的人判断。
- **TD-004 的确认点**：令牌“机密配置”落地为数据库中的摘要登记表，删除即生效、无需重启。若技术负责人在确认设计时改选“应用机密 + 重新部署”（替代方案 A），IQA-021 将无法在一次独立测试运行中执行，需要相应修订测试安排。
