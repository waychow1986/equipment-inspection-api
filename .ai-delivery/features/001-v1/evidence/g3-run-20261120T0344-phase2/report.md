# G3 独立测试报告 · 阶段 2/2（最终）

- 候选：`794c04968859b952fd222631c9564f9ea648edc5`（服务 inspection-api，`AIDH_SERVICE_INSPECTION_API_URL`）
- 测试计划：`tasks-qa.md` version 3，指纹 `sha256:06f424c4a8e03e932c5b87c0358dbd80f7a05c457e0e730b26e15846e449e231`（已核对 tasks-qa.md + runtime/qa-run.sh + runtime/qa-phases.json 内容的 SHA-256 与锁定指纹一致）
- 阶段 1：运行标记 `qa6vbzj2hg`，结束于 2026-11-20T03:42:20Z，证据 `../g3-run-20261120T0341-phase1/`
- 受控重新部署：2026-11-20T03:43:15Z 开始、03:43:24Z 完成，Pod 全部由本次重部署新建（`redeploy-evidence.json`，取自 `QA_REDEPLOY_EVIDENCE`）

## 执行说明（平台问题）

1. 按原样以 `QA_PHASE=2`、`QA_PHASES=2` 执行锁定的 `runtime/qa-run.sh`：平台恢复的 `QA_STATE_DIR` 为空，脚本按计划第 7 节判为测试缺口“未找到阶段 1 保存的状态”（证据 `as-is/`）。这是平台跨阶段状态未恢复的问题，不是产品缺陷。
2. 阶段 1 的证据完整保存了重部署前（03:42）M1 对 D1～D5（`IQA-008-late.json`，阶段 1 结束时的查询）与 D16（`IQA-021-phase1.json`）的原始响应。用 `reconstruct-state.py` 由这些证据重建阶段 1 状态（持有人标识只在内存中由注入机密还原，状态文件写在仓库外的临时目录、执行后删除），再以该目录作为 `QA_STATE_DIR` 执行同一锁定脚本，未修改测试计划与脚本。结果见 `qa-result.json`、`qa-run-console.log`，脚本退出码 0。
3. 证据目录已扫描，不含任何注入机密的原文。

## 场景结果（阶段 2）

| 场景 | 结果 | 说明 | 证据 |
| --- | --- | --- | --- |
| IQA-018 | 通过 | 重部署后 D1～D5 查询均 200；条数（1/1/1/2/3）、记录标识与全部字段与重部署前完全一致 | `IQA-018.json`、`redeploy-evidence.json` |
| IQA-020 | 通过 | IQA-011、IQA-012、IQA-021 的失败响应（头与正文）不含令牌原文 | `IQA-020.json` |
| IQA-019 | 无法验证（测试缺口） | 未提供 `QA_SERVICE_LOG_URL`；G2 人的决定：日志导出地址不提供，按测试缺口处理 | `IQA-019.json` |
| IQA-021（删除后步骤） | 无法验证（测试缺口） | I2 在重部署后仍被识别（提交 201、查询 403）；G2 人的决定：I2 在两阶段间不删除，按测试缺口处理。其余检查点通过：I1 提交 D17 被接受，M1 查询 D16 与删除前保存结果完全一致 | `IQA-021-phase2.json`、`../g3-run-20261120T0341-phase1/IQA-021-phase1.json` |

产品缺陷 0 条。阶段 1 的 IQA-001～IQA-017 全部通过（见阶段 1 报告）。

## 验收标准（最终）

| 验收标准 | 结果 | 依据 |
| --- | --- | --- |
| AC-01 | 通过 | 阶段 1：IQA-001、IQA-002、IQA-003 |
| AC-02 | 通过 | 阶段 1：IQA-003、IQA-004、IQA-010、IQA-017 |
| AC-03 | 通过 | 阶段 1：IQA-004、IQA-005 |
| AC-04 | 通过 | 阶段 1：IQA-006 |
| AC-05 | 通过 | 阶段 1：IQA-007 |
| AC-06 | 通过 | 阶段 1：IQA-008、IQA-009、IQA-010 |
| AC-07 | 通过 | 阶段 2：IQA-018 |
| AC-08 | 无法验证（测试缺口，`test-gap`） | IQA-014（阶段 1）与 IQA-020 通过；IQA-019（日志中不出现凭据与巡检记录内容）因 G2 人的决定不提供日志导出地址而无法验证，交 G4 确认是否接受 |

## 依赖假设（交 G4 判断）

- A-1～A-7：接口细节由 OpenAPI 发现（`POST /v1/inspection-records`，`GET /v1/inspection-records?deviceId=`；字段 recordId/deviceId/storeId/conclusion/note/inspectorId/submittedAt；结论 NORMAL/ABNORMAL；Bearer 令牌；状态码含义）。
- A-11：平台受控重新部署同一候选即“服务重启”（AC-07）。
- A-12、A-13：见上，按 G2 人的决定处理为测试缺口。
