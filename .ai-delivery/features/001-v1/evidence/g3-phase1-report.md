# G3 独立测试报告（阶段 1/2）

- 候选：`cand-9a30c99046e5`，candidateSha `1ed17bdd964365c19093d40cf687684814fba0f9`，服务 `inspection-api`（`/healthz` 返回 200）。
- 测试计划：`tasks-qa.md` version 3，锁定指纹 `sha256:06f424c4a8e03e932c5b87c0358dbd80f7a05c457e0e730b26e15846e449e231`；脚本 `runtime/qa-run.sh`，分阶段声明 `runtime/qa-phases.json`（`redeployBefore: ["IQA-018"]`）。计划与脚本未修改。
- 证据：
  - 平台 qa-run 阶段 1 证据：`evidence/`（运行标记 `qa8atbmib5`；其中 `testedCommitSha` 为 `98906df1…`，与本次候选 SHA 不同）。
  - 本 Agent 对当前候选重新执行锁定脚本阶段 1（`QA_CANDIDATE_SHA=1ed17bd…`）：`evidence/rerun-1ed17bd-phase1/`（运行标记 `qazru1xczs`）。两次结果一致。证据已扫描，未出现令牌或机密原文。

## 阶段 1 场景结果

IQA-001～IQA-017、IQA-021（阶段 1 步骤）全部通过；产品缺陷 0 条，测试缺口 0 条。IQA-018、IQA-019、IQA-020 属于阶段 2，需在受控重新部署后执行。

## 验收标准结果

| 验收标准 | 覆盖场景 | 结果 | 说明 |
| --- | --- | --- | --- |
| AC-01 | IQA-001、002、003 | 通过 | |
| AC-02 | IQA-003、004、010、017 | 通过 | |
| AC-03 | IQA-004、005 | 通过 | |
| AC-04 | IQA-006 | 通过 | |
| AC-05 | IQA-007 | 通过 | |
| AC-06 | IQA-008、009、010 | 通过 | |
| AC-07 | IQA-018 | 无法验证（环境/平台） | 需受控重新部署后的阶段 2；已请求重部署 |
| AC-08 | IQA-014、019、020 | 无法验证（环境/平台） | IQA-014 通过；IQA-019/020 属阶段 2；IQA-019 必需的机密 `QA_SERVICE_LOG_URL` 未注入 |

## 依赖的假设（交 G4 判断）

所有场景依赖 A-1～A-7（接口路径、字段、状态码由候选 OpenAPI `/openapi.json` 发现：`POST /v1/inspection-records`、`GET /v1/inspection-records?deviceId=`，字段 `deviceId/storeId/conclusion/note`，结论 `NORMAL/ABNORMAL`）；另：IQA-003/004 依赖 A-8（时间容差 ±120 秒），IQA-001/003/014 依赖 A-10（持有人标识），IQA-008/017 依赖 A-9，IQA-018 依赖 A-11，IQA-021 依赖 A-12，IQA-019 依赖 A-13。

## 待办

1. 请技术负责人在项目“依赖与机密”页签提供机密 `QA_SERVICE_LOG_URL`（test 环境；如需认证一并提供可选的 `QA_SERVICE_LOG_TOKEN`）。
2. 平台受控重新部署同一候选（A-12：重部署前由运维从测试环境机密配置删除 I2），随后执行阶段 2（IQA-018、IQA-021 删除后步骤、IQA-019、IQA-020）。
