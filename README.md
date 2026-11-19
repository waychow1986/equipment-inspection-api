# equipment-inspection-api
AIDelivery Hub project: 记录门店设备巡检结果的后端服务

TypeScript + Fastify + PostgreSQL 的 HTTP JSON 服务。巡检员凭访问令牌提交巡检结果；记录只追加、不可修改或删除。接口描述见运行中服务的 `GET /openapi.json`（无需令牌）。

## 本地开发

需要 Node.js 22，以及已注入 `AIDH_DEP_INSPECTION_DB_*` 变量的 PostgreSQL（Agent Pod 中为 `dev` 实例）。

```bash
npm ci
npm run lint && npm run typecheck   # 静态检查
npm run build                       # 编译到 dist/
npm run test:unit                   # 单元测试（无需数据库）
npm run test:integration            # 集成测试（真实 PostgreSQL，每次使用独立 schema，结束后删除）
npm run test:functional             # 功能测试（启动真实进程 + 真实 PostgreSQL）
```

集成与功能测试缺少数据库变量时直接失败，不会跳过。

本地启动（令牌清单的生成方法见下文“运维说明”）：

```bash
export AIDH_SECRET_INSPECTION_ACCESS_TOKENS='[{"sha256":"<摘要>","holder":"demo-inspector","role":"inspector"}]'
INSPECTION_DB_SCHEMA=inspection_dev_$RANDOM PORT=8080 node dist/server.js
```

## 接口

| 方法与路径 | 身份 | 说明 |
|---|---|---|
| `POST /v1/inspection-records` | 巡检员令牌 | 提交一条巡检结果，字段 `deviceId`、`storeId`、`conclusion`（`NORMAL`/`ABNORMAL`）、可选 `note`；成功返回 201 与记录 |
| `GET /healthz` | 无 | 数据库可用时 200 `{"status":"ok"}`，否则 503 |
| `GET /openapi.json` | 无 | OpenAPI 3 接口描述 |

令牌以 `Authorization: Bearer <令牌>` 传递。失败统一为 `{"error":{"code","message","fields?"}}`，判定次序为 401（未识别身份）→ 403（无权执行该操作）→ 400/413（输入不符合要求，`fields` 指明字段）。巡检员与提交时间由服务端决定，请求中的同名字段被忽略。

## 配置（环境变量）

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `AIDH_DEP_INSPECTION_DB_ADDRESS` | 是 | — | `主机名:端口` |
| `AIDH_DEP_INSPECTION_DB_DATABASE` | 是 | — | 数据库名（也用于派生写入角色名） |
| `AIDH_DEP_INSPECTION_DB_USERNAME` | 是 | — | 所有者用户 |
| `AIDH_DEP_INSPECTION_DB_PASSWORD` | 是 | — | 机密 |
| `AIDH_DEP_INSPECTION_DB_SSLMODE` | 否 | `disable` | `disable` / `require` / `verify-full` |
| `AIDH_DEP_INSPECTION_DB_AUTH_MODE` | 否 | `credential` | 只支持 `credential` |
| `AIDH_SECRET_INSPECTION_ACCESS_TOKENS` | 是 | — | 令牌清单（JSON 数组，见下文）；机密 |
| `PORT` | 否 | `8080` | 监听端口 |
| `LOG_LEVEL` | 否 | `info` | `debug`/`info`/`warn`/`error` |
| `INSPECTION_DB_SCHEMA` | 否 | `inspection` | 仅测试时覆盖为独立 schema |
| `DB_POOL_MAX` | 否 | `10` | 请求连接池上限（1～100） |

缺少必需变量或取值非法时，进程记录 `fatal` 日志“配置无效”及变量名（令牌清单另带条目序号与原因代码，不含清单内容）后以退出码 1 结束。

启动时服务在 advisory lock 下执行 `migrations/` 中的迁移（多实例并发启动安全），确保只追加触发器与写入角色 `<数据库名>_<schema>_writer` 存在；处理请求的连接切换到该写入角色，只有插入与查询权限，任何修改、删除、清空记录的尝试都会被数据库拒绝。

## 日志

日志为 JSON 行（stdout），字段按白名单输出：访问日志只有 `event`、`requestId`、`method`、路由模板、`statusCode`、`durationMs`、`errorCode`；错误只记录错误名与 `errCode`。日志中不出现令牌、令牌摘要、持有人标识、数据库地址或密码，也不出现设备、门店、结论、备注等记录内容。

## 运维说明（Runbook）

令牌清单保存在项目机密 `INSPECTION_ACCESS_TOKENS` 中（注入为 `AIDH_SECRET_INSPECTION_ACCESS_TOKENS`），每项为：

```json
{"sha256":"<令牌的 SHA-256 十六进制小写摘要>","holder":"<持有人标识，如工号>","role":"inspector 或 manager"}
```

清单只保存摘要，不保存令牌明文。

| 情况 | 处理 |
|---|---|
| 生成新令牌 | 在运维自己的终端执行 `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`（或 `openssl rand -base64 32`），得到令牌明文（≥32 个字符）；通过既有的安全渠道交给持有人，不写入工单、聊天或代码库 |
| 计算摘要 | `read -rs TOKEN && printf '%s' "$TOKEN" \| sha256sum \| cut -d' ' -f1 && unset TOKEN`（不带换行计算；令牌不出现在命令行参数与 shell 历史中） |
| 新增巡检员/管理人员 | 在 `INSPECTION_ACCESS_TOKENS` 中追加一项，保存后让平台重新部署（或重启）服务；`/healthz` 恢复 200 后生效。同一人需要两种能力时登记两个令牌 |
| 收回权限 | 从 `INSPECTION_ACCESS_TOKENS` 删除该条目，重新部署（或重启）服务；新进程就绪、旧进程退出后，该令牌一律 401；持有人已有记录不受影响 |
| 确认生效 | 启动日志 `service started` 中的 `tokenCount` 与清单条目数一致；用被收回的令牌调用应得到 401 |
| 令牌疑似泄露 | 先删除条目并重新部署，再按“生成新令牌”发放新令牌 |
| 启动退出且日志“配置无效” | 日志给出变量名；若是令牌清单，另给出条目序号 `entryIndex` 与原因代码 `reason`（如 `INVALID_SHA256`），据此修正机密后重新部署 |
| `/healthz` 503 或错误日志中 `errCode` 为 `08xxx`/`57P0x` | 检查数据库实例状态与网络；服务恢复连接后自动可用 |
| 启动失败，`errCode` 为 `42501` 且消息为“写入角色不可用” | 数据库连接用户缺少 `CREATEROLE` 或不是写入角色成员；由数据库管理员授予后重启 |
| 请求处理中出现 `errCode` `42501` 或 `P0001` | 有代码试图修改/删除记录或越权访问，属缺陷；记录未被改变 |
| 回滚 | 重新部署上一版本镜像；无需数据操作 |

## 部署

`Dockerfile` 为多阶段构建（`node:22-bookworm-slim`），以非 root 用户 `10001` 运行 `node dist/server.js`，监听 8080，健康检查路径 `/healthz`。部署声明见 `docs/deployment.json`。
