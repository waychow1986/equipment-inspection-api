# 设备巡检记录服务技术方案

> 依据：已确认的意图（version 2，`confirmed: true`）、规格 `spec.md`（FR-001～FR-029、IQA-001～IQA-021，PQ-001～PQ-004 已有人工答案）、已锁定的独立测试计划（`tasks-qa.md`、`runtime/qa-run.sh`、`runtime/qa-phases.json`）、项目宪章、平台运行参考（依赖声明 v3、部署声明 v2、Agent Pod、独立测试契约）。
> 本方案只回答“怎么做”，不改变规格中已确认的产品行为。
>
> **本版修订（S22）**：G2（第 0021 次）退回技术方案，S6（第 0022 次）按退回后的决定重排计划。本版按这些决定修订：
> ① 令牌改用“应用机密”方案（原 TD-004 的替代方案 A）：清单只含“令牌摘要—持有人标识—角色”，作为服务的应用机密 `INSPECTION_ACCESS_TOKENS` 注入，服务启动时加载；收回令牌即修改机密并重新部署。删除原令牌登记表 `access_token`、`token-admin` CLI，以及“独立测试直连数据库登记令牌”的做法。
> ② 契约增加无需身份即可访问的 `GET /openapi.json`（OpenAPI 3.0.3），供调用方与独立测试发现接口。
> ③ 数据库按最小权限拆分：迁移使用依赖注入的所有者账号；处理请求的会话切换到只具备 `inspection_record` INSERT/SELECT 权限的写入角色；TD-003 的表述改为准确说法。
> ④ 不声明候选服务日志的导出地址；IQA-019 在独立测试中记为测试缺口，AC-08 以开发者侧对真实进程完整输出的零命中检查作为证据，由 G4 判断。
> ⑤ Runbook 与 README 写明运维登记、收回令牌的步骤。
> ⑥ 依赖绑定前检查（S30 门禁反馈）：`docs/dependencies.json` 的接入字段改为大写名称 `ADDRESS`、`DATABASE`、`USERNAME`、`PASSWORD`、`SSLMODE`（与注入的环境变量后缀一致，应用读取的 `AIDH_DEP_INSPECTION_DB_*` 不变），平台生成的机密改名为 `DB_PASSWORD`，容器变量与连接模板中的占位同步改为 `{{secret.DB_PASSWORD}}`。
> 其余内容（技术栈、数据模型中的巡检记录表、错误模型、日志白名单、部署形态）与上一版相同。

## 技术上下文（Technical Context）

| 项 | 选择 |
|---|---|
| 仓库现状 | 新项目，仓库只有 `README.md`、交付文档、依赖与部署声明；没有既有代码、技术基线或客户技术偏好记录 |
| 语言 / 运行时 | TypeScript 5.x，Node.js 22 LTS（Agent Pod 预装 Node 22） |
| Web 框架 | Fastify 5（可关闭请求自动日志，自带 pino 结构化日志） |
| 持久化 | PostgreSQL（推荐 16，最低 14），驱动 `pg` 8.x |
| 测试 | Vitest（单元 / 集成 / 功能三类，分别对应开发者验证类别） |
| 静态检查 | `tsc --noEmit` + ESLint（typescript-eslint） |
| 交付形态 | 单个容器化 HTTP 服务 `inspection-api`，对外暴露，端口 8080 |
| 外部依赖 | 仅 1 个：`inspection-db`（PostgreSQL），推荐平台以容器运行 |
| 应用机密 | `INSPECTION_ACCESS_TOKENS`（令牌摘要清单，服务读取）；另有独立测试用的测试身份机密（见“Secret 处理”） |
| 目标规模 | 规格未设定性能/容量指标；按门店网络少量并发、单设备记录量不大设计（意图假设） |

## 治理与技术约束

| 约束来源 | 内容 | 设计响应 |
|---|---|---|
| 宪章·产品与架构 | 最简单的满足需求的架构；记录重大决策与有理由的例外 | 单服务 + 单数据库，无缓存、无消息队列；令牌清单不入库；重大决策见 TD 表，例外见 TD-003、TD-013 |
| 宪章·安全与隐私 | 凭据保留在服务端；least privilege；验证输入；不记录 secret 或客户内容 | 令牌只以 SHA-256 摘要出现在机密中；请求会话使用最小权限写入角色；输入逐项校验；日志字段白名单 |
| 宪章·测试与质量 | 外部集成用真实测试服务做 contract/integration/E2E；Mock 不作验收证据 | 集成与功能测试连接平台注入的 `dev` PostgreSQL 实例；`realInstance.dev/test` 均为 true |
| 意图·客户约束 | 交付一个后端服务，不做前端 | 只提供 HTTP JSON API（外加 OpenAPI 描述文档） |
| 规格 PQ-003 | 无统一身份系统；令牌—持有人—角色对应关系由运维作为服务的机密配置提供；删除令牌并让服务重新加载即收回；不做账号管理接口 | TD-004：清单作为应用机密注入，启动时加载；修改机密 + 重新部署（或重启）即重新加载 |
| 已锁定的测试计划 | 令牌“已在测试环境机密配置中”；I2 由运维在两个阶段之间删除，随受控重新部署生效（A-12）；入口优先从 OpenAPI 发现（A-1）；持有人按 `QA_INSPECTOR_*_HOLDER` 核对 | TD-004 与之对齐；TD-014 提供 `/openapi.json`；test 环境机密中 I1、I2 的持有人标识与 `QA_INSPECTOR_*_HOLDER` 一致 |
| 平台·候选部署 | 镜像非 root（数字 UID）；网络默认拒绝；对外服务经网关 TLS 终止后以 HTTP 转发 | Dockerfile `USER 10001`；服务只访问已声明的 `inspection-db` |
| 平台·依赖注入 | 应用只从 `AIDH_DEP_*` 读取依赖配置、从 `AIDH_SECRET_*` 读取应用机密；只实现 `AIDH_DEP_{N}_AUTH_MODE` 所示的认证方式 | 配置模块只读这些变量；数据库仅支持 `credential`，其他值启动失败 |
| 平台·验证 | 开发者命令在注入 `dev` 实例变量的 Pod 中执行，不设计“无依赖”模式 | 集成/功能测试直接连接 `dev` 实例，用独立 schema 与独立写入角色隔离 |

## 架构概览（Architecture）

```
 巡检员 / 管理人员的调用方
          │ HTTPS（平台网关终止 TLS）
          ▼
 ┌──────────────────────────── inspection-api（Node 22 / Fastify） ─────────────────────────────┐
 │  公开：GET /healthz、GET /openapi.json（不经身份钩子）                                        │
 │  业务：routes ──► authenticate（Bearer → SHA-256 → 进程内令牌表） ──► 角色 ──► 输入校验      │
 │           └──► repository ──► 请求连接池（会话角色 = 写入角色 <db>_<schema>_writer）──┐      │
 │  启动：config（含 AIDH_SECRET_INSPECTION_ACCESS_TOKENS 解析）→ 迁移连接（所有者账号，   │      │
 │        advisory lock：版本迁移 + 写入角色与授权）→ 关闭迁移连接 → 开始监听               │      │
 │  logger（pino，字段白名单）                                                              │      │
 └──────────────────────────────────────────────────────────────────────────────────────────┼──────┘
                                                                                            ▼
                                   inspection-db（PostgreSQL，schema `inspection`）
                                     ├─ inspection_record（只增不改：写入角色无 UPDATE/DELETE 权限 + 触发器）
                                     └─ schema_migration（只有所有者可访问）

 运维 ──► 项目机密 INSPECTION_ACCESS_TOKENS（摘要清单）──► 重新部署 / 重启 ──► 服务启动时重新加载
```

- 服务无业务状态：巡检记录全部在 PostgreSQL；令牌清单来自应用机密，只在进程内存中保存（不入库、不落盘）。服务进程重启不丢失任何已确认的记录（FR-022）。
- “让服务重新加载”= 服务进程以新的机密值重新启动（平台重新部署或重启容器）；启动完成并通过健康检查后，新清单对所有请求生效（FR-027、FR-028）。

## 技术决策与替代方案

| 决策 ID | 选择 | 理由 | 已考虑替代方案 | 来源 |
|---|---|---|---|---|
| TD-001 | TypeScript + Node 22 + Fastify 5 | 无既有基线；Agent Pod 预装 Node 22；Fastify 可关闭自动请求日志、自带 pino，便于满足日志隐私 | Java/Spring Boot（更重）；Python/FastAPI（可行，日志与校验需更多拼装）；.NET（可行，无优势） | 宪章·最简架构 |
| TD-002 | PostgreSQL 作为唯一持久化（推荐平台以容器运行 `postgres:16-alpine`，带持久卷） | 部署声明不支持为服务挂卷，服务容器本地文件在重新部署后丢失，必须有外部持久化才能满足 AC-07；事务与 fsync 保证“接受即已保存” | 容器内 SQLite（重新部署丢数据，否决）；Azure Database for PostgreSQL（`cloud`，需 IaC，增加成本与复杂度；客户可在依赖任务中改选） | FR-001、FR-022、AC-07 |
| TD-003 | 记录不可变，三层保证：① API 不提供修改/删除端点；② 处理请求的数据库会话以写入角色执行，该角色对 `inspection_record` 只有 INSERT/SELECT 权限；③ 触发器拒绝 `UPDATE`/`DELETE`/`TRUNCATE` | 服务代码中的缺陷（包括误写的 SQL）无法通过请求路径修改或删除已有记录，也无法停用触发器或改动表结构。**残余风险**：服务进程同时持有所有者凭据（启动迁移需要），能完全控制服务进程、或取得所有者凭据、或拥有数据库超级用户权限的人仍可改写历史；这一点由凭据保护（机密来源注入、不记录）与数据库运维管控承担，记为有理由的例外（见 TD-013） | 仅靠应用层不提供端点（防护较弱）；单独的迁移任务使用所有者账号、服务只拿写入角色的凭据（部署声明没有一次性任务，且平台只为依赖注入一组凭据，见 TD-013） | FR-021、Q5、宪章 least privilege |
| TD-004 | “机密配置”实现为应用机密 `INSPECTION_ACCESS_TOKENS`（注入为 `AIDH_SECRET_INSPECTION_ACCESS_TOKENS`）：JSON 数组，每项只含令牌 SHA-256 摘要、持有人标识、角色。服务启动时解析并校验，构建进程内只读查找表；缺失或格式错误时拒绝启动。收回/新增令牌 = 运维修改机密并让平台重新部署（或重启）服务 | ① 与 PQ-003 人工答案原文“机密配置 + 删除后重新加载”一致；② 与已锁定测试计划一致（令牌已在 test 机密配置中，I2 在两阶段之间删除并随受控重新部署生效，A-12）；③ 令牌明文不进入服务、数据库、镜像或仓库，机密中只有摘要；④ 不需要令牌表、管理 CLI，也不需要运维进入集群内网，最简单；⑤ 服务不暴露任何令牌管理端点（FR-029） | 原方案：数据库令牌登记表 + `token-admin` CLI（独立测试无法登记测试令牌，运维需进入集群内网，G2 退回）；两者结合：启动时把机密同步到令牌表（行为相同，多一层同步逻辑）；Azure Key Vault + 定时重载（引入云依赖与身份配置） | PQ-003、FR-003、FR-017、FR-027～FR-029、IQA-021、tasks-qa A-12 |
| TD-005 | 身份凭据走 `Authorization: Bearer <token>` 请求头 | 标准做法；不出现在 URL，避免进入网关/访问日志 | 自定义请求头；查询参数（会进 URL，否决） | FR-023、FR-026 |
| TD-006 | 查询用 `GET /v1/inspection-records?deviceId=...`，不把设备标识放进路径；只记录路由模板 | 缺少设备标识时能作为“输入不符合要求”返回 400 并指明字段（FR-016），而不是路由 404；日志只写路由模板，不含设备标识 | `GET /v1/devices/{deviceId}/inspection-records`（缺设备时只能 404，且路径含客户内容） | FR-016、FR-024、FR-025 |
| TD-007 | 巡检结论在接口中用代码值 `NORMAL`（正常）/ `ABNORMAL`（异常），其他取值一律拒绝；OpenAPI 中以 `enum` 声明并说明对应关系 | 机器可读、与语言无关 | 直接使用中文字面值“正常/异常”（可行，但对调用方编码不友好） | FR-001、FR-006、PQ-002 |
| TD-008 | 提交时间由数据库在插入时 `clock_timestamp()` 生成（UTC，毫秒精度输出）；排序 `submitted_at DESC, seq DESC` | 时间来源唯一、不受请求内容影响；同一毫秒内的并列由单调递增序号决定 | 应用进程时间（多实例时钟可能不一致） | FR-004、FR-013 |
| TD-009 | 记录标识为服务生成的 UUID v4（`crypto.randomUUID()`），内部另有自增 `seq` | 对外标识不可猜测、不泄露数量；`seq` 用于稳定排序 | 只用自增 ID（可枚举） | FR-001 |
| TD-010 | 数据库迁移：服务启动时用所有者账号的独立连接，在 `pg_advisory_lock` 下按序执行仓库内的 SQL 迁移（只做向前、可叠加的变更），随后幂等地确保写入角色及其授权；完成后关闭该连接 | 单服务、无额外迁移工具；锁保证多副本同时启动时只执行一次；所有者连接不参与请求处理 | node-pg-migrate / Flyway（额外依赖，收益小） | FR-022 |
| TD-011 | 集成/功能测试在 `dev` 实例中为每次运行创建独立 schema（`inspection_t_<随机>`）及对应写入角色，结束时删除两者 | 记录表禁止删除，独立 schema 避免测试数据积累且互不干扰；仍是真实 PostgreSQL | 共享 schema + 唯一前缀（数据只增不减，长期积累） | 宪章·测试与质量 |
| TD-012 | 不设请求速率限制与分页 | 规格未要求；意图假设单设备记录量不大、第一版不分页 | 加分页（改变 FR-014 行为，否决） | FR-014 |
| TD-013 | 写入角色 `<数据库名>_<schema>_writer`（默认 `inspection_inspection_writer`，`NOLOGIN`）：迁移时由所有者创建并授予 schema `USAGE`、`inspection_record` 的 `INSERT, SELECT` 及其 identity 序列的 `USAGE`，并把该角色授予所有者本身（以便切换）；请求连接池的每个会话在建立时切换到该角色（`SET ROLE`）。角色名含数据库名，避免多个项目复用同一 PostgreSQL 实例时冲突 | 满足宪章 least privilege：请求路径上的会话无法 UPDATE/DELETE/TRUNCATE、无法改表或停用触发器、无法访问迁移表。平台只为依赖注入一组凭据（所有者），所以用“所有者登录 + 会话切换角色”的方式，而不是第二组登录凭据。**有理由的例外**：所有者凭据仍在服务进程的环境变量中（见 TD-003 的残余风险） | 单一所有者账号直接处理请求（不满足最小权限，G2 退回）；启动时为写入角色生成随机登录密码并用它建连接池（每次启动轮换密码，多副本滚动部署时会让旧副本新建连接失败，且客户托管实例可能禁止改密码）；客户提供两组凭据（增加运维负担，平台容器形态无法生成第二组） | 宪章 least privilege、G2 意见 |
| TD-014 | 提供 `GET /openapi.json`（OpenAPI 3.0.3，无需身份；带 `Authorization` 头访问也照常返回）：描述两条业务路由、请求字段、`conclusion` 枚举、查询参数 `deviceId`、响应与错误结构、Bearer 安全方案；文档是 `src/openapi/document.ts` 中的静态对象，不含任何凭据或示例令牌 | 调用方与独立测试可以从文档发现入口与字段（已锁定测试计划 A-1、A-3、A-4 优先读取 `/openapi.json`）；静态文档不引入额外依赖；契约测试保证文档与实际行为一致 | `@fastify/swagger` 自动生成（多一个依赖，且需要把校验改成 Fastify Schema 才能自动对齐）；不提供文档、改用测试脚本的候选路径（测试计划已锁定，`/v1/inspection-records` 不在候选路径中） | G2 阻断意见、tasks-qa A-1 |

## 领域与数据模型

### 巡检记录 `inspection.inspection_record`

| 列 | 类型 | 约束 | 对应规格 |
|---|---|---|---|
| `seq` | `bigint GENERATED ALWAYS AS IDENTITY` | 主键；仅内部排序用，不对外 | FR-013 |
| `record_id` | `uuid` | `NOT NULL UNIQUE`；服务生成 | 记录标识，FR-001 |
| `device_id` | `text` | `NOT NULL`，1～128 字符（去除首尾空白后） | 设备标识，FR-005、FR-011 |
| `store_id` | `text` | `NOT NULL`，1～128 字符（去除首尾空白后） | 门店标识，FR-006 |
| `conclusion` | `text` | `NOT NULL CHECK (conclusion IN ('NORMAL','ABNORMAL'))` | 巡检结论，FR-006 |
| `note` | `text` | 可空；≤2000 字符；未填写或仅空白时为 `NULL` | 备注，FR-007 |
| `inspector_id` | `text` | `NOT NULL`；来自令牌清单中该令牌的持有人标识 | 提交的巡检员，FR-003 |
| `submitted_at` | `timestamptz` | `NOT NULL DEFAULT clock_timestamp()`；插入语句不提供此列 | 提交时间，FR-004 |

- 索引：`inspection_record_device_idx ON (device_id, submitted_at DESC, seq DESC)`，支撑按设备查询与排序。
- 触发器 `inspection_record_immutable`：`BEFORE UPDATE OR DELETE ... FOR EACH ROW` 抛出异常（SQLSTATE `P0001`，消息固定为 `inspection_record is append-only`，不含任何数据）；`TRUNCATE` 由语句级触发器同样拒绝。
- 不存在外键：服务不维护设备/门店档案（FR-008、Q3）。

### 迁移登记 `inspection.schema_migration`

`version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()`。迁移文件 `migrations/NNN_<name>.sql`，第一版只有 `001_initial.sql`（创建 schema、上述两张表、索引、触发器）。迁移 SQL 中 schema 名以占位符书写，由迁移执行器替换为经校验、加引号的标识符。

### 写入角色与授权（TD-013，每次启动在迁移之后幂等执行）

在同一 advisory lock 内、以所有者连接执行（`<w>`、`<s>` 为经校验并用 `escapeIdentifier` 加引号的标识符）：

1. 若 `pg_roles` 中不存在 `<w>`：`CREATE ROLE <w> NOLOGIN`（所有者需具备 `CREATEROLE` 或为超级用户，见依赖约束 `role-privileges`）；若已存在但所有者不是其成员且无权授予 → 启动失败，日志给出 SQLSTATE 与“写入角色不可用”（不含其他内容）。
2. `GRANT <w> TO CURRENT_USER`（使所有者能 `SET ROLE`；已是成员时为无操作）。
3. `REVOKE ALL ON <s>.inspection_record, <s>.schema_migration FROM <w>`，再 `GRANT USAGE ON SCHEMA <s> TO <w>`、`GRANT SELECT, INSERT ON <s>.inspection_record TO <w>`、`GRANT USAGE ON SEQUENCE <inspection_record 的 identity 序列> TO <w>`（用 `pg_get_serial_sequence` 取得）。不授予 `UPDATE`、`DELETE`、`TRUNCATE`、`REFERENCES`、`TRIGGER`，也不授予 `schema_migration` 的任何权限。
4. 写入角色名：`<数据库名>_<schema>_writer`，先转小写，再把 `[a-z0-9_]` 以外的字符替换为 `_`；结果必须匹配 `^[a-z_][a-z0-9_]{0,62}$`，否则启动失败（“配置无效”，只写变量名）。默认部署为 `inspection_inspection_writer`。

请求连接池：每个新建连接先执行 `SET ROLE <w>`，再执行 `SET statement_timeout = 5000`，完成后才交给请求使用（以 `pg` 连接池的 `connect` 事件实现，或等价地在连接参数 `options` 中写入 `-c role=<w> -c statement_timeout=5000`；无论用哪种，集成测试都要验证 `current_user` 为写入角色）。服务代码中不出现 `RESET ROLE`、`SET ROLE NONE` 或 `SET SESSION AUTHORIZATION`。

### 令牌清单（应用机密 `INSPECTION_ACCESS_TOKENS`，TD-004）

注入为 `AIDH_SECRET_INSPECTION_ACCESS_TOKENS`，值为 UTF-8 JSON 数组：

```json
[
  { "sha256": "<64 位小写十六进制>", "holder": "zhang.san", "role": "inspector" },
  { "sha256": "<64 位小写十六进制>", "holder": "wang.wu",  "role": "manager" }
]
```

| 键 | 规则 |
|---|---|
| `sha256` | 必填；`^[0-9a-f]{64}$`；令牌 UTF-8 字节（不含换行）的 SHA-256 小写十六进制；在清单中唯一 |
| `holder` | 必填；去除首尾空白后 1～128 字符，不含控制字符；非秘密的持有人标识（工号或登录名），作为记录中的“提交的巡检员” |
| `role` | 必填；`inspector`（巡检员）或 `manager`（管理人员） |
| 其他键 | 不允许（拒绝启动），避免运维误把令牌明文写进诸如 `token` 的键 |

- 一个令牌只对应一位持有人和一种角色（规格假设）；同一人需要两种能力时登记两个令牌（PQ-004）。同一持有人可以有多个条目。
- 清单为空数组时服务照常启动，所有业务请求得到 401，并以 `warn` 记录“未配置任何访问令牌”（不含其他内容）。
- 变量缺失、不是合法 JSON、不是数组、条目不合规或摘要重复：以 `fatal` 记录“配置无效”、变量名、条目序号与原因代码（如 `INVALID_SHA256`、`DUPLICATE_SHA256`、`UNKNOWN_KEY`），**不输出变量值、JSON 解析器的错误消息或任何条目内容**，进程退出码 1（候选部署健康检查因此失败，问题在部署阶段即暴露）。
- 令牌要求：≥32 个字符的高熵随机串（运维生成方式见 Runbook）；摘要不加盐即可抵抗离线猜测。
- 删除某条目并重新加载即收回该令牌；已有巡检记录只保存 `holder` 文本，不受影响（FR-027）。

### 输入规范化规则（规格假设“空值视同缺少”）

- `deviceId`、`storeId`、`note`、查询参数 `deviceId`：若为字符串，先去除首尾空白；去除后为空串视同缺少。保存与查询都使用去除首尾空白后的值，保证“同一台设备”按同一标识判定。
- 非字符串类型（数字、对象、数组、`null`）视为“输入不符合要求”，原因 `INVALID_TYPE`（`note` 为 `null` 时视同未填写）。
- 长度上限：`deviceId`、`storeId` 128 字符；`note` 2000 字符；超出时原因 `TOO_LONG`。这是“验证输入”（宪章）的保护性上限，正常巡检数据不会触及。
- 请求体中未定义的字段（如 `inspector`、`submittedAt`、`inspectorId`）被忽略，不导致拒绝，也不影响记录（FR-003、FR-004、IQA-003）。

## Component 边界与项目结构

Coding 会创建或修改的路径（写路径清单）：

- `package.json`、`package-lock.json`、`tsconfig.json`、`tsconfig.build.json`、`eslint.config.mjs`、`vitest.config.ts`、`.dockerignore`、`.gitignore`、`.nvmrc`
- `Dockerfile`
- `README.md`（含运维说明：令牌生成、登记、收回，见 Runbook）
- `src/`
  - `src/server.ts`：进程入口（读取配置、执行迁移与角色授权、建立请求连接池、启动 HTTP、优雅退出）
  - `src/app.ts`：构建 Fastify 实例（路由、错误处理、钩子），供测试直接注入
  - `src/config.ts`：从环境变量读取并校验配置（见“配置”）
  - `src/logger.ts`：pino 配置（级别标签、字段白名单、序列化器）
  - `src/db/pool.ts`：`pg` 连接池（请求池切换写入角色、TLS 模式、超时）
  - `src/db/migrate.ts`：迁移执行器与写入角色授权（所有者连接）
  - `src/auth/token-config.ts`：解析与校验 `AIDH_SECRET_INSPECTION_ACCESS_TOKENS`，构建只读查找表
  - `src/auth/authenticate.ts`：Bearer 解析、摘要计算、401/403 判定的 Fastify 钩子
  - `src/inspections/routes.ts`：两条业务路由
  - `src/inspections/validation.ts`：输入规范化与字段级错误
  - `src/inspections/repository.ts`：插入与按设备查询
  - `src/http/errors.ts`：统一错误响应体与错误处理器
  - `src/health/routes.ts`：`/healthz`
  - `src/openapi/document.ts`、`src/openapi/routes.ts`：OpenAPI 文档与 `/openapi.json`
- `migrations/`：`migrations/001_initial.sql`
- `test/`
  - `test/unit/`：校验、令牌清单解析、Bearer 解析、错误映射、日志序列化器、OpenAPI 文档结构（不连库）
  - `test/integration/`：连接 `dev` PostgreSQL 的迁移、写入角色权限、仓储、触发器测试
  - `test/functional/`：启动真实服务进程（localhost）+ `dev` PostgreSQL 的端到端 HTTP 测试，含重启、令牌收回与日志隐私检查
  - `test/support/`：测试 schema 与写入角色的创建/清理、随机令牌与令牌清单生成、合成数据、进程启动与日志捕获工具
- 当前 Feature 目录下的 `runtime/deployment.json`（开发者命令）
- 以下由技术方案产出，Coding 不修改：`docs/dependencies.json`、`docs/deployment.json`、`deploy/probes/inspection-db.sh`；已锁定的 `tasks-qa.md`、`runtime/qa-run.sh`、`runtime/qa-phases.json` 也不修改

```
.
├── Dockerfile
├── package.json / package-lock.json / tsconfig*.json / eslint.config.mjs / vitest.config.ts
├── migrations/001_initial.sql
├── src/{server,app,config,logger}.ts
├── src/{db,auth,inspections,http,health,openapi}/
├── test/{unit,integration,functional,support}/
├── docs/{dependencies.json,deployment.json}
└── deploy/probes/inspection-db.sh
```

模块边界：路由层只做协议转换；`authenticate` 钩子只挂在 `/v1/*` 业务路由上，在处理前完成身份与角色判定，只读 `token-config` 构建的查找表；`validation` 只做纯函数校验；`repository` 是唯一访问 `inspection_record` 的位置，只使用请求连接池；`migrate` 是唯一使用所有者连接的位置。

## 数据流、状态、并发与生命周期

### 提交（FR-001～FR-009、FR-017、FR-019）

1. 读取 `Authorization`；缺失、非 `Bearer` 格式、令牌为空或长度 >512 → 401 `UNAUTHENTICATED`。
2. 计算令牌 UTF-8 字节的 SHA-256 小写十六进制，在进程内查找表中查找；无条目 → 401。
3. 角色不是 `inspector` → 403 `FORBIDDEN`（先于输入校验，管理人员令牌无论请求体如何都得到“无权执行该操作”）。
4. 解析 JSON 请求体（`Content-Type: application/json`，≤16 KiB）；非 JSON / 解析失败 / 不是对象 → 400，字段 `body`。
5. 规范化与校验 `deviceId`、`storeId`、`conclusion`、`note`，汇总全部字段错误 → 400。
6. 经请求连接池（写入角色）执行单条参数化 `INSERT ... RETURNING`，`record_id` 由服务生成，`inspector_id` 取自第 2 步条目的 `holder`，`submitted_at` 由数据库生成；事务提交后才返回 201。
7. 第 1～5 步任何拒绝都不触达 `INSERT`，因此不产生记录（不变量 1）。

### 查询（FR-010～FR-016、FR-017、FR-018、FR-020）

1～2. 同提交。3. 角色不是 `manager` → 403。4. 校验查询参数 `deviceId`（缺失/空白/重复出现/超长 → 400）。
5. `SELECT ... WHERE device_id = $1 ORDER BY submitted_at DESC, seq DESC`，一次返回全部（FR-014）；无行返回 `records: []`（FR-012）。不按门店过滤（FR-015）。

### 并发与一致性

- 每次提交是独立的单行插入，无读后写、无唯一业务键，重复内容也各自成行（FR-009）；无需应用层锁。
- 查询使用默认 `READ COMMITTED`；201 返回前已提交，之后的查询必然可见。
- 令牌查找表在启动时构建后只读，请求之间无共享可变状态。令牌清单变化只在新进程中生效；平台重新部署期间新旧进程可能短暂并存，旧进程仍按旧清单判定，直到被停止（收回在新进程全部就绪、旧进程退出后完全生效；Runbook 中“确认生效”一步即为此）。

### 生命周期

- 启动：读取并校验配置（含令牌清单）→ 用所有者账号建立单个迁移连接（不可达时每 2 s 重试，最长 60 s）→ 获取 advisory lock → 执行迁移 → 确保写入角色与授权 → 释放锁并关闭迁移连接 → 建立请求连接池（写入角色）→ 监听 `0.0.0.0:8080` → 记录 `service started` 与已加载的令牌条目**数量**（不含其他内容）。
- 停止：收到 `SIGTERM`/`SIGINT` → 停止接受新连接，等待在途请求（最多 10 s）→ 关闭连接池 → 退出码 0。
- 未捕获异常 / 未处理的 Promise 拒绝：以 `fatal` 级别记录（只含错误名与错误码）后退出码 1，由平台重启。

## Interface 与契约（Contract）

基础约定：

- 基础地址：候选环境为平台给出的对外 HTTPS 地址（`AIDH_SERVICE_INSPECTION_API_URL`）；业务路径以 `/v1` 开头。
- 编码：请求与响应均为 `application/json; charset=utf-8`。
- 身份：业务接口必须携带 `Authorization: Bearer <访问令牌>`；`/healthz` 与 `/openapi.json` 无需身份，携带 `Authorization` 头时也忽略它（不校验、不拒绝）。
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
| 401 | `UNAUTHENTICATED` | 未识别身份 | 缺少/格式错误的 `Authorization`；令牌摘要不在当前加载的令牌清单中（含已收回）。附 `WWW-Authenticate: Bearer` | FR-017、FR-027 |
| 403 | `FORBIDDEN` | 无权执行该操作 | `manager` 提交；`inspector` 查询 | FR-018～FR-020 |
| 400 | `VALIDATION_FAILED` | 输入不符合要求 | 字段错误，`fields[]` 列出每个不符合要求的字段 | FR-005、FR-006、FR-016 |
| 404 | `NOT_FOUND` | 资源不存在 | 未定义的路径/方法（包括任何 `PUT`/`PATCH`/`DELETE` 记录的尝试、任何令牌管理路径） | FR-021、FR-029 |
| 413 | `VALIDATION_FAILED` | 输入不符合要求 | 请求体超过 16 KiB，`fields: [{ "field": "body", "reason": "TOO_LARGE" }]` | 宪章·验证输入 |
| 503 | `SERVICE_UNAVAILABLE` | 服务暂不可用 | 数据库不可达/超时；未产生记录 | — |
| 500 | `INTERNAL_ERROR` | 服务内部错误 | 其他未预期错误（含写入角色权限被拒，SQLSTATE `42501`） | — |

- 判定顺序固定：身份（401）→ 角色（403）→ 输入（400）。
- `fields[].field` 取值：`deviceId`、`storeId`、`conclusion`、`note`、`body`；`fields[].reason` 取值：`REQUIRED`（缺少或空白）、`INVALID_TYPE`、`INVALID_VALUE`（结论不在允许值内）、`TOO_LONG`、`MULTIPLE_VALUES`（查询参数重复）、`MALFORMED`（请求体不是 JSON 对象）、`TOO_LARGE`。
- 错误响应不包含请求中的任何取值。

### GET /healthz — 健康检查（平台使用，无需身份）

经请求连接池执行 `SELECT 1`，2 s 内成功 → `200 {"status":"ok"}`；否则 `503 {"status":"unavailable"}`。不返回版本、配置或任何业务数据。

### GET /openapi.json — 接口描述文档（无需身份，TD-014）

返回 `200`，`Content-Type: application/json`，内容为 OpenAPI 3.0.3 文档，要求如下（第 1 批包含提交路由，第 2 批补上查询路由）：

- `info.title` 为“设备巡检记录服务”，`info.version` 为 `1.0.0`；`servers` 只写相对地址 `/`，不写任何主机名。
- `components.securitySchemes.bearerAuth`：`type: http`、`scheme: bearer`；两条业务操作写 `security: [{ "bearerAuth": [] }]`。**文档中不出现任何令牌、示例令牌、摘要、持有人标识或连接信息。**
- `paths` 只包含 `/v1/inspection-records`（下有 `post` 与 `get`）与 `/healthz`；`/healthz` 的 `summary` 写“健康检查”，不使用 inspection、record、巡检等词（避免被误认为业务入口）。
- `post`：`operationId: submitInspectionRecord`，`summary` 含“提交巡检记录（submit inspection record）”；`requestBody.required: true`，`content.application/json.schema` 为**内联**对象（不使用 `$ref`、`oneOf`、`anyOf`），`required: [deviceId, storeId, conclusion]`，`properties`：
  - `deviceId`：string，`minLength: 1`，`maxLength: 128`，说明“设备标识”；
  - `storeId`：string，`minLength: 1`，`maxLength: 128`，说明“门店标识”；
  - `conclusion`：string，`enum: [NORMAL, ABNORMAL]`，说明“巡检结论：NORMAL=正常，ABNORMAL=异常”；
  - `note`：string，`nullable: true`，`maxLength: 2000`，说明“备注，可选”。
  - 属性按上面的顺序列出；`additionalProperties` 不声明（多余字段被忽略）。
  - 响应：`201`（记录对象，含 `Location` 头说明）、`400`、`401`、`403`、`413`、`503`（错误对象）。
- `get`：`operationId: listInspectionRecordsByDevice`，`summary` 含“按设备查询历史巡检记录（list inspection records by device）”；`parameters` 写在操作上：`{ name: deviceId, in: query, required: true, schema: { type: string, minLength: 1, maxLength: 128 } }`；响应 `200`（`{ deviceId, records: [记录对象] }`）、`400`、`401`、`403`、`503`。
- 记录对象与错误对象可以放在 `components.schemas` 中被响应引用；请求体 schema 与查询参数必须按上文内联。
- 文档是常量，不随配置或数据变化；`Cache-Control: no-cache`。

### 外部依赖契约

唯一外部依赖 `inspection-db` 为标准 PostgreSQL 协议（≥14），使用上文的 schema 与写入角色；`realInstance.dev` 与 `realInstance.test` 均为 true，不需要模拟服务。连接用户（所有者）需要：在数据库中创建 schema `inspection`（或对已有 schema 拥有 CREATE、USAGE），以及创建写入角色（`CREATEROLE` 或超级用户；或写入角色已存在且连接用户是其成员）——分别对应依赖约束 `schema-privileges` 与 `role-privileges`，由探测脚本报告。

平台以容器运行时（`docs/dependencies.json` 的 `container`）：
- 镜像 `postgres:16-alpine` 默认以 root 启动入口脚本，平台不以 root 运行依赖容器，因此 `runAs` 写出镜像中已有的 `postgres` 用户：UID 70、GID 70（Alpine 版官方镜像固定的数值）。以该用户直接启动时，入口脚本跳过切换用户与 `chown`，直接以 UID 70 执行 `initdb` 与 `postgres`；`/var/run/postgresql` 在镜像中已对所有用户可写。
- 持久卷挂载在 `/var/lib/postgresql/data`，其根目录经 `fsGroup` 对 GID 70 可写但属主不是 UID 70；`initdb` 要求数据目录属主为自己且权限 0700，所以数据目录 `PGDATA` 设为挂载路径下的子目录 `/var/lib/postgresql/data/pgdata`，由入口脚本以 UID 70 创建。
- `POSTGRES_USER=inspection` 为该实例的超级用户，满足 `schema-privileges` 与 `role-privileges`；服务处理请求时不使用它的权限，而是切换到写入角色（TD-013）。
- 数据库密码由平台按 `generatedSecrets: [DB_PASSWORD]` 生成，经 `POSTGRES_PASSWORD={{secret.DB_PASSWORD}}` 设给容器，并经连接模板的 `PASSWORD` 字段注入为 `AIDH_DEP_INSPECTION_DB_PASSWORD`；连接模板的键 `ADDRESS`、`DATABASE`、`USERNAME`、`PASSWORD`、`SSLMODE` 与接入字段名称完全一致。
- 健康检查为 `pg` 端口（5432）的 TCP 检查；初始化完成、服务器监听后即通过。

## 安全、隐私、身份与 Secret

### 身份与授权（FR-017～FR-020、FR-027～FR-029）

| 调用者 | `POST /v1/inspection-records` | `GET /v1/inspection-records` |
|---|---|---|
| 令牌清单中 `role = inspector` 的令牌 | 允许 | 403 |
| 令牌清单中 `role = manager` 的令牌 | 403 | 允许（任意门店的任意设备） |
| 无令牌 / 令牌摘要不在当前加载的清单中 / 已收回 | 401 | 401 |

- 服务只比较摘要：对出示的令牌计算 SHA-256 后在查找表中按键查找，不保存、不比较明文。
- 记录中的巡检员只取清单中的 `holder`；请求体中的同类字段被忽略（FR-003）。
- 服务没有任何令牌管理端点；令牌只能由运维通过项目机密维护（FR-029）。

### Secret 处理

| Secret | 来源 | 进入应用的方式 | 保护措施 |
|---|---|---|---|
| 数据库密码（所有者） | 平台为容器生成（`generatedSecrets: DB_PASSWORD`，接入字段 `PASSWORD`）或客户提供 | `AIDH_DEP_INSPECTION_DB_PASSWORD`（机密来源注入） | 只在建立连接时使用；不记录、不回显；配置错误信息只写变量名 |
| 令牌清单 `INSPECTION_ACCESS_TOKENS` | 运维在项目机密中提供（按环境分别提供；本交付的验证只需要 `test` 值） | `AIDH_SECRET_INSPECTION_ACCESS_TOKENS` | 只含摘要、持有人、角色；启动时解析后只保留查找表；整体与条目内容都不记录（FR-023“机密配置的内容”） |
| 访问令牌明文 | 运维生成后经安全渠道交给持有人 | 调用方的 `Authorization` 头 | 服务从不保存；日志、响应、错误中都不出现 |
| 测试令牌 I1、I2、M1、X 与持有人标识 | 项目机密 `QA_INSPECTOR_1_TOKEN`、`QA_INSPECTOR_2_TOKEN`、`QA_MANAGER_TOKEN`、`QA_INVALID_TOKEN`、`QA_INSPECTOR_1_HOLDER`、`QA_INSPECTOR_2_HOLDER`（仅 `test`） | 独立测试环境的 `AIDH_SECRET_*` | 服务不读取这些变量；`INSPECTION_ACCESS_TOKENS` 的 `test` 值必须登记 I1、I2、M1 的摘要（见“独立测试需要的环境条件”）；脚本与证据中不写令牌原文 |

- 宪章“支持时使用 managed identity”：平台以容器运行的 PostgreSQL 不支持托管身份，只能用 `credential`；若客户改选支持 Entra ID 的托管 PostgreSQL，需要另行修订本方案（应用当前只实现 `credential`，遇到其他 `AUTH_MODE` 启动失败并给出明确错误）。
- Coding 自测不需要任何人提供的令牌或 `dev` 机密值：功能测试在运行时生成随机令牌，计算摘要并组成令牌清单，以环境变量 `AIDH_SECRET_INSPECTION_ACCESS_TOKENS` 传给自己启动的服务进程；令牌只在测试进程内存中。

### 输入与传输

- 所有 SQL 使用参数化查询；schema 名与写入角色名只来自配置/派生规则，启动时按 `^[a-z_][a-z0-9_]{0,62}$` 校验后用 `escapeIdentifier` 加引号使用。
- 请求体上限 16 KiB；只接受 `application/json`。
- 对外 TLS 由平台网关终止；数据库连接 TLS 由 `AIDH_DEP_INSPECTION_DB_SSLMODE` 决定（容器形态为 `disable`，集群内网络；客户提供的托管实例应为 `require` 或 `verify-full`）。
- 容器以 UID 10001 运行，不写本地文件。

### 日志隐私（FR-023、FR-024、AC-08）

- 关闭 Fastify 自动请求日志（`disableRequestLogging: true`），由 `onResponse` 钩子写一条访问日志，字段白名单：`time`、`level`、`msg`、`event`、`requestId`、`method`、`route`（路由模板，如 `/v1/inspection-records`，**不是**带查询串的 URL）、`statusCode`、`durationMs`、`errorCode`（如 `VALIDATION_FAILED`）。
- 永不记录：请求 URL/查询串、请求头、请求体、响应体、令牌及其摘要、令牌清单的值或条目、持有人标识、设备/门店标识、备注、结论、记录标识、数据库连接信息与角色名以外的任何 SQL 文本。
- 错误序列化器只输出 `errName`（如 `DatabaseError`）与 `errCode`（如 SQLSTATE `57P01`），不输出 `message`、`detail`、`stack`（PostgreSQL 的 `detail` 会包含行数据；JSON 解析错误信息会包含请求体或机密片段）。
- pino `redact` 额外屏蔽 `req.headers.authorization`、`headers.authorization`、`*.password`、`*.token`、`*.sha256` 作为纵深防御。
- 开发者侧证据：功能测试在全部场景（含重启、令牌收回）执行后，对捕获的服务标准输出/错误逐一检索本次使用的全部令牌、令牌摘要、持有人标识、设备/门店标识与备注标记，要求零命中。第 1 批与第 2 批各执行一次（第 2 批包含查询串中的 `deviceId`）。
- 独立验收：本交付不声明候选服务日志的导出地址（`QA_SERVICE_LOG_URL`），IQA-019 在独立测试中按测试计划 A-13 记为测试缺口（环境/平台问题）；AC-08 的 IQA-014、IQA-020 照常独立验收。IQA-019 缺口是否接受由 G4 判断。

## 配置、可观测性与运维

### 配置（全部来自环境变量）

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `AIDH_DEP_INSPECTION_DB_ADDRESS` | 是 | — | `主机名:端口` |
| `AIDH_DEP_INSPECTION_DB_DATABASE` | 是 | — | 数据库名（也用于派生写入角色名） |
| `AIDH_DEP_INSPECTION_DB_USERNAME` | 是 | — | 所有者用户 |
| `AIDH_DEP_INSPECTION_DB_PASSWORD` | 是 | — | 机密 |
| `AIDH_DEP_INSPECTION_DB_SSLMODE` | 否 | `disable` | `disable` / `require` / `verify-full` |
| `AIDH_DEP_INSPECTION_DB_AUTH_MODE` | 否 | `credential` | 只支持 `credential` |
| `AIDH_SECRET_INSPECTION_ACCESS_TOKENS` | 是 | — | 令牌清单（JSON 数组，见数据模型）；机密 |
| `PORT` | 否 | `8080` | 监听端口 |
| `LOG_LEVEL` | 否 | `info` | `debug`/`info`/`warn`/`error` |
| `INSPECTION_DB_SCHEMA` | 否 | `inspection` | 仅测试覆盖为独立 schema |
| `DB_POOL_MAX` | 否 | `10` | 请求连接池上限 |

缺少必需变量或取值非法时，进程以 `fatal` 记录“配置无效”及变量**名**（令牌清单另带条目序号与原因代码）后退出码 1。

### 日志与错误识别

- 输出：标准输出，每行一个 JSON 对象（pino），`level` 以文本标签输出（`formatters.level` → `"level":"error"`），消息字段 `msg`。
- 级别约定：`info` 启动（含令牌条目数量）、迁移完成、访问日志（2xx/4xx）；`warn` 令牌清单为空、数据库瞬时错误后恢复；`error` 5xx、数据库不可达、迁移或角色授权失败；`fatal` 配置无效（含令牌清单无效）、未捕获异常。4xx 是调用方问题，不记为 `error`。
- `docs/deployment.json` 的 `operations.errorLogRules`（与上一版相同，按上述实际写法）：
  - `app-error-log`（`kind: structured`，`field: level`，`values: [error, fatal]`，`messageField: msg`，severity high）：发现 5xx、数据库与迁移故障、令牌清单无效、崩溃。
  - `node-uncaught-error`（`kind: pattern`，severity high）：日志器初始化前的非 JSON 崩溃输出（如 `Error: Cannot find module …`）。
- 指标与追踪：规格无要求，第一版不引入；`X-Request-Id` 用于把调用方报障与访问日志关联。

## SLO、限制、扩缩容、重试与恢复

- 规格没有批准的时限、容量或可用率指标，本方案不设 SLO。设计目标（非承诺）：单次提交/查询 p95 < 200 ms。
- 限制：请求体 16 KiB；字段长度见契约；查询不分页（FR-014）；令牌清单在内存中，条目数按门店人员规模（数百至数千）设计。
- 扩缩容：服务无状态，可水平扩展；第一版部署 1 副本。迁移与角色授权在 advisory lock 下执行，多副本同时启动安全；所有副本读取同一机密，清单一致。
- 数据库超时：连接超时 5 s，语句超时 5000 ms；连接池错误时返回 503，不自动重试写入（避免重复插入；调用方收到 503 可重新提交，最坏情况与“再提交一条”语义一致）。
- 启动时数据库不可达：每 2 s 重试连接，最长 60 s，仍失败则 `fatal` 退出，由平台重启。
- 恢复：数据库数据在持久卷上；服务重启后直接可查（FR-022）。数据库备份由依赖实例的提供方负责（容器形态为持久卷；生产建议客户提供带备份的托管实例）。

## 部署拓扑、迁移、Rollout 与 Rollback

- 部署声明 `docs/deployment.json`：服务 `inspection-api`，构建上下文 `.`，构建文件 `Dockerfile`，端口 8080，`healthPath: /healthz`，`exposed: true`（与上一版相同）。
- 镜像：多阶段构建，`node:22-bookworm-slim`；构建阶段 `npm ci` + `npm run build`；运行阶段 `npm ci --omit=dev`，复制 `dist/` 与 `migrations/`，`USER 10001`，`CMD ["node","dist/server.js"]`。
- 网络：入站只到 8080（经网关）；出站只到 `inspection-db` 的目标地址。
- **平台前提（P-1）**：候选部署时，服务容器获得项目机密 `INSPECTION_ACCESS_TOKENS` 的 `test` 值（依赖声明参考：应用自身需要的值写在 `secrets` 中，注入为 `AIDH_SECRET_{NAME}`），且受控重新部署时读取当时的机密值。若该变量未注入，服务按设计拒绝启动、健康检查失败，问题在候选部署阶段即可见；届时需要平台补上注入，不在应用中设计绕过（例如把清单写进镜像）。
- 迁移：服务启动时执行，只做向前、可叠加变更（新增表/列/索引），不在同一版本中删除或重命名旧结构；写入角色授权每次启动幂等重放。
- Rollout：平台以候选 SHA 构建镜像并部署；`/healthz` 通过即就绪（配置有效、数据库可达、迁移与授权完成后才开始监听）。
- 令牌变更的发布：修改项目机密 `INSPECTION_ACCESS_TOKENS` → 平台重新部署（或重启）服务 → 新进程就绪即生效；不需要构建新镜像。
- Rollback：重新部署上一版本镜像；迁移只做可叠加变更，旧版本可在新 schema 上运行；不回滚数据，巡检记录不会因回滚丢失。上一版本若是令牌登记表方案的构建，不在本交付范围内（本交付首次发布即采用本方案）。

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

- `test:integration` 与 `test:functional` 直接使用注入的 `AIDH_DEP_INSPECTION_DB_*`（`dev` 实例）；变量缺失时测试**失败**而不是跳过。它们不读取 `dev` 环境的 `AIDH_SECRET_*`：令牌清单由测试自行生成并传给被测进程。
- 每条命令都必须实际执行到测试；Vitest 配置 `passWithNoTests: false`。
- 测试支撑在每次运行结束（含失败）时以所有者连接执行 `DROP SCHEMA <测试 schema> CASCADE` 与 `DROP ROLE IF EXISTS <测试写入角色>`。

### 测试分层与覆盖

| 层 | 内容 | 覆盖 |
|---|---|---|
| 单元 | 输入规范化与字段错误（缺失、空白、类型、超长、结论非法、额外字段忽略）；令牌清单解析（合法、空数组、非 JSON、非数组、摘要格式错、重复摘要、未知键、角色非法、持有人为空），并断言错误输出不含变量值；Bearer 解析；错误码映射与判定顺序；日志序列化器不输出 `message/detail/stack`；OpenAPI 文档结构（见下文契约测试） | FR-005～FR-008、FR-016、FR-023、FR-025、FR-026 |
| 集成（真实 PostgreSQL） | 迁移幂等与并发启动（两次迁移并行）；写入角色：请求池会话 `current_user` 为写入角色，`UPDATE`/`DELETE`/`TRUNCATE inspection_record`、`ALTER TABLE`、`ALTER TABLE ... DISABLE TRIGGER`、访问 `schema_migration` 都被拒绝（SQLSTATE `42501`）；所有者会话下 `UPDATE`/`DELETE`/`TRUNCATE` 仍被触发器拒绝（`P0001`）；重复启动后授权不变；插入后可查；排序与并列；按设备隔离 | FR-001、FR-009～FR-013、FR-021、宪章 least privilege |
| 功能（真实进程 + 真实 PostgreSQL） | 在 localhost 启动 `node dist/server.js`（测试生成的令牌清单），按规格 IQA-001～IQA-017、IQA-020 的操作与预期逐条执行；IQA-018：停止进程后以相同配置重新启动，比对 D1～D5 查询结果完全一致；IQA-021：从清单删除 I2 的条目后重启进程，验证 I2 的提交与查询 401、I1 照常、I2 已有记录不变；FR-028：新增条目并重启后被识别；令牌清单无效时进程以非零码退出且输出不含清单内容；IQA-019 的开发者侧证据：捕获进程全部 stdout/stderr，检索令牌、摘要、持有人、设备/门店/备注标记零命中 | AC-01～AC-08 |
| 契约（OpenAPI） | 功能测试先只读取 `/openapi.json`（带与不带 `Authorization` 头各一次，都 200），按与独立测试相同的规则从文档中找出提交入口（含 inspection/record 的 POST）、`conclusion` 的枚举与查询入口（带 `in: query` 且名称含 device 的 GET），再用找到的入口与字段名完成一次提交与查询；断言文档中没有本次运行的任何令牌、摘要或持有人标识 | TD-014、tasks-qa A-1、A-3、A-4 |

### 独立测试（QA）需要的环境条件

已锁定的测试计划（`tasks-qa.md` 第 2 节、A-12、A-13，`runtime/qa-phases.json` 的 `redeployBefore: ["IQA-018"]`）不访问数据库，只读取 `AIDH_SECRET_*` 并调用候选服务。本方案与它的对接方式：

| 事项 | 做法 |
|---|---|
| 测试身份 | 技术负责人在项目机密中提供 `test` 值：`QA_INSPECTOR_1_TOKEN`、`QA_INSPECTOR_2_TOKEN`、`QA_MANAGER_TOKEN`（三者互不相同，各 ≥32 个字符的高熵随机串）、`QA_INVALID_TOKEN`（可选，不得登记），`QA_INSPECTOR_1_HOLDER`、`QA_INSPECTOR_2_HOLDER`（I1、I2 的持有人标识，例如 `qa-inspector-1`、`qa-inspector-2`，互不相同） |
| 令牌成为已识别身份 | 同一位技术负责人/运维在项目机密 `INSPECTION_ACCESS_TOKENS` 的 `test` 值中登记三项：I1 的摘要 + `holder` = `QA_INSPECTOR_1_HOLDER` 的值 + `inspector`；I2 的摘要 + `holder` = `QA_INSPECTOR_2_HOLDER` 的值 + `inspector`；M1 的摘要 + 任意持有人（如 `qa-manager`）+ `manager`。X 的摘要不得出现。候选部署时服务加载该清单（平台前提 P-1） |
| IQA-018（重启） | 平台在阶段 1 与阶段 2 之间受控重新部署同一候选；巡检记录在 `inspection-db` 的 `test` 实例中，重新部署后仍可查 |
| IQA-021（收回 I2） | 运维在阶段 1 结束后、受控重新部署之前，从 `INSPECTION_ACCESS_TOKENS` 的 `test` 值中删除 I2 的条目；受控重新部署即“让服务重新加载”。**独立测试结束后**把 I2 的条目加回，否则下一次独立测试的阶段 1 会因 I2 已被拒绝而记为环境问题（A-12） |
| IQA-019（日志） | 不声明 `QA_SERVICE_LOG_URL`；按 A-13 记为测试缺口（环境/平台问题），AC-08 的这一部分以开发者侧零命中检查为证据，由 G4 判断 |
| 接口发现 | 测试脚本从 `/openapi.json` 发现 `POST /v1/inspection-records`（字段 `deviceId`/`storeId`/`conclusion`/`note`，结论 `NORMAL`/`ABNORMAL`）与 `GET /v1/inspection-records?deviceId=`（TD-014） |

## 验证环境责任矩阵（Verification Environment）

| 验证类型 | 责任阶段 | 环境来源 | 依赖/凭据 | Coding 证据 | 下游结果 |
|---|---|---|---|---|---|
| 静态检查 | Coding / 候选验证 | Agent Pod 同镜像 | 无 | `npm run lint`、`npm run typecheck` 通过 | 候选验证记录 |
| 构建 | Coding / 候选验证；ACR Tasks | Agent Pod；ACR | 无 | `npm run build` 通过；Dockerfile 非 root | 候选镜像 |
| 单元测试 | Coding / 候选验证 | Agent Pod | 无 | `npm run test:unit` 报告 | 候选验证记录 |
| 集成测试（contract/integration） | Coding / 候选验证 | Agent Pod + `inspection-db` `dev` 实例 | `AIDH_DEP_INSPECTION_DB_*`（dev） | `npm run test:integration` 报告（含写入角色权限） | 候选验证记录 |
| 功能 / 端到端 / OpenAPI 契约 | Coding / 候选验证 | Agent Pod localhost 进程 + `dev` 实例 | 同上；令牌与清单运行时生成 | `npm run test:functional` 报告（含重启、收回、日志零命中检查） | 候选验证记录 |
| 依赖探测 | 依赖与机密任务 | 平台隔离探测环境 | 本依赖的 `AIDH_DEP_INSPECTION_DB_*` | — | 探测结果（可达、认证、3 条约束） |
| 候选部署健康 | 平台 | `cand-{deliveryShortId}` | `test` 实例；`AIDH_SECRET_INSPECTION_ACCESS_TOKENS`（test，P-1） | — | `/healthz` 200 |
| 独立验收 IQA-001～IQA-021 | 独立测试 | QA Pod → 候选 HTTPS 地址 | `AIDH_SECRET_QA_*`（test）；运维在两阶段之间修改 `INSPECTION_ACCESS_TOKENS`（test） | — | `qa-run.sh` 结果与证据；IQA-019 预计为测试缺口 |
| 运行期错误发现 | 平台 | 候选运行日志 | — | — | 按 `errorLogRules` 生成问题报告 |

## 快速验证指南（Quickstart）

在 Agent Pod 中（已注入 `dev` 实例变量）：

```bash
npm ci && npm run build
INSPECTOR=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
MANAGER=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
export AIDH_SECRET_INSPECTION_ACCESS_TOKENS="[{\"sha256\":\"$(sha "$INSPECTOR")\",\"holder\":\"demo-inspector\",\"role\":\"inspector\"},{\"sha256\":\"$(sha "$MANAGER")\",\"holder\":\"demo-manager\",\"role\":\"manager\"}]"
INSPECTION_DB_SCHEMA=inspection_dev_$RANDOM PORT=8080 node dist/server.js &
curl -s localhost:8080/openapi.json | head -c 200
curl -s -X POST localhost:8080/v1/inspection-records -H "Authorization: Bearer $INSPECTOR" \
  -H 'Content-Type: application/json' -d '{"deviceId":"D-1","storeId":"S-1","conclusion":"NORMAL"}'
curl -s "localhost:8080/v1/inspection-records?deviceId=D-1" -H "Authorization: Bearer $MANAGER"
```

预期：`/openapi.json` 返回文档；提交返回 201 与记录；查询返回 1 条记录；用巡检员令牌查询返回 403。结束后删除临时 schema 与对应写入角色。

## 支持 Runbook（README 运维说明按此编写）

| 情况 | 处理 |
|---|---|
| 生成新令牌 | 在运维自己的终端执行 `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`（或 `openssl rand -base64 32`），得到令牌明文；通过既有的安全渠道交给持有人，不写入工单、聊天或代码库 |
| 计算摘要 | `read -rs TOKEN && printf '%s' "$TOKEN" \| sha256sum \| cut -d' ' -f1 && unset TOKEN`（不带换行计算；令牌不出现在命令行参数与 shell 历史中） |
| 新增巡检员/管理人员（FR-028） | 在项目机密 `INSPECTION_ACCESS_TOKENS` 中追加 `{"sha256":"<摘要>","holder":"<工号>","role":"inspector"或"manager"}`，保存后让平台重新部署（或重启）服务；`/healthz` 恢复 200 后生效。同一人需要两种能力时登记两个令牌 |
| 收回权限（FR-027） | 从 `INSPECTION_ACCESS_TOKENS` 删除该条目，重新部署（或重启）服务；新进程就绪、旧进程退出后，该令牌一律 401；持有人已有记录不受影响 |
| 确认生效 | 服务启动日志 `service started` 中的令牌条目数量与清单一致；用被收回的令牌调用应得到 401 |
| 令牌疑似泄露 | 先删除条目并重新部署，再按“生成新令牌”发放新令牌 |
| 启动退出且日志“配置无效” | 日志给出变量名；若是令牌清单，另给出条目序号与原因代码（如 `INVALID_SHA256`），据此修正机密后重新部署 |
| `/healthz` 503 或 `app-error-log` 报告 `errCode` 为 `08xxx`/`57P0x` | 检查 `inspection-db` 实例状态与网络；服务恢复连接后自动可用 |
| 启动失败，`errCode` 为 `42501` 且消息为“写入角色不可用” | 数据库连接用户缺少 `CREATEROLE` 或不是写入角色成员；由数据库管理员授予后重启（依赖探测的 `role-privileges` 会提前报告） |
| `errCode` 为 `42501` 或 `P0001` 出现在请求处理中 | 有代码试图修改/删除记录或越权访问，属缺陷；记录未被改变 |
| 回滚 | 重新部署上一版本镜像；无需数据操作 |

## 开放决策与风险

本方案按 G2 退回后的五项决定修订，本阶段的技术决定已全部作出，无阻塞事项。随本方案确认的事项：

- **P-1（平台前提）**：候选部署的服务容器能获得应用机密 `INSPECTION_ACCESS_TOKENS` 的 `test` 值，受控重新部署时读取最新值。不满足时服务拒绝启动，在候选部署阶段即可见。
- **R-1（运维配合）**：IQA-021 依赖运维在两个阶段之间删除 I2 的条目、并在测试结束后加回；未按时操作时，测试计划按 A-12 记为环境问题，不判为产品缺陷。
- **R-2（AC-08 独立验收缺口）**：IQA-019 预计记为测试缺口；AC-08 的日志部分只有开发者侧证据（两批功能测试对真实进程完整输出的零命中检查），由 G4 判断是否接受。
- **R-3（残余风险，TD-003/TD-013）**：服务进程持有数据库所有者凭据；能控制服务进程或取得该凭据的人仍可改写记录。这是“平台只注入一组依赖凭据、部署声明没有一次性迁移任务”下的有理由的例外。
