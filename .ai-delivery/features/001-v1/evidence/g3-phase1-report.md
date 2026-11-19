# G3 独立测试报告（阶段 1/2）

- 候选：`cand-9a30c99046e5`，candidateSha `445c400ac4748c31a8f38ef8e40675a603ff66d4`，服务 `inspection-api`（平台报告 healthy）。
- 测试计划：`tasks-qa.md` version 3，锁定指纹 `sha256:06f424c4a8e03e932c5b87c0358dbd80f7a05c457e0e730b26e15846e449e231`；脚本 `runtime/qa-run.sh`，分阶段声明 `runtime/qa-phases.json`（`redeployBefore: ["IQA-018"]`）。计划与脚本未修改。
- 本次证据：本 Agent 以 QA 身份对当前候选执行锁定脚本阶段 1（`QA_PHASE=1`、`QA_PHASES=2`、`QA_CANDIDATE_SHA=445c400…`），运行标记 `qay12rwb2s`，证据在 `evidence/rerun-445c400-phase1/`（`qa-result-phase1.json`、`run.json`、`discovery.json`、各场景 `IQA-xxx.json`）。结果中的 `testedCommitSha` 与候选一致。
- 历史证据：`evidence/` 根目录（`testedCommitSha` 98906df…）与 `evidence/rerun-1ed17bd-phase1/` 是对较早候选的执行，仅供参考，不作为本候选的结论依据。
- 证据已扫描：全部测试令牌、无效令牌、服务令牌配置与数据库口令原文均未出现在证据与跨阶段状态中。

## 阶段 1 场景结果

IQA-001～IQA-017 与 IQA-021（阶段 1 步骤）全部通过；产品缺陷 0 条，测试缺口 0 条。接口由候选 `/openapi.json` 发现：`POST /v1/inspection-records`、`GET /v1/inspection-records?deviceId=`，字段 `deviceId/storeId/conclusion/note`，结论 `NORMAL/ABNORMAL`。IQA-018、IQA-019、IQA-020 属阶段 2，需在受控重新部署后执行。

## 验收标准结果

| 验收标准 | 覆盖场景 | 结果 | 证据 / 说明 |
| --- | --- | --- | --- |
| AC-01 | IQA-001、002、003 | 通过 | `IQA-001.json`、`IQA-002.json`、`IQA-003.json` |
| AC-02 | IQA-003、004、010、017 | 通过 | `IQA-003.json`、`IQA-004.json`、`IQA-010.json`、`IQA-017.json` |
| AC-03 | IQA-004、005 | 通过 | `IQA-004.json`、`IQA-005.json` |
| AC-04 | IQA-006 | 通过 | `IQA-006.json` |
| AC-05 | IQA-007 | 通过 | `IQA-007.json` |
| AC-06 | IQA-008、009、010 | 通过 | `IQA-008.json`、`IQA-008-late.json`、`IQA-009.json`、`IQA-010.json` |
| AC-07 | IQA-018 | 无法验证（环境/平台） | 需同一候选受控重新部署后的阶段 2；本阶段已保存 D1～D5 查询结果并请求重部署 |
| AC-08 | IQA-014、019、020 | 无法验证（环境/平台） | IQA-014 通过（响应中不含令牌原文）；IQA-020 属阶段 2；IQA-019 所需日志地址不提供（见测试缺口） |

## 测试缺口（按 G2 的人工答复记录，不再提问）

1. **服务日志不可读取（IQA-019，AC-08）**：G2 答复服务日志导出地址 `QA_SERVICE_LOG_URL` 不提供。按假设 A-13，IQA-019“日志中不出现凭据与巡检记录内容”无法由独立测试验证，记为测试缺口（环境/平台问题）。AC-08 的日志部分需由人另行确认。
2. **I2 在两个阶段之间不删除（IQA-021 阶段 2）**：G2 答复不删除 I2。按假设 A-12，阶段 2 中“收回令牌后被拒绝”的检查将无法成立，记为测试缺口（环境/平台问题），不判为产品缺陷。IQA-021 不映射到任何 AC 编号，但影响总体通过条件。

## 依赖的假设（交 G4 判断）

所有场景依赖 A-1～A-7（接口路径、字段、状态码由候选 OpenAPI 发现）；另：IQA-001/003 依赖 A-10，IQA-003/004 依赖 A-8（时间容差 ±120 秒），IQA-008/017 依赖 A-9，IQA-018 依赖 A-11，IQA-021 依赖 A-12，IQA-019 依赖 A-13。

## 下一步

平台受控重新部署同一候选，随后执行阶段 2（IQA-018、IQA-021 删除后步骤、IQA-019、IQA-020）。
