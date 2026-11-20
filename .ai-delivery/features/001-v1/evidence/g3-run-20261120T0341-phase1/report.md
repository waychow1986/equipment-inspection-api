# G3 独立测试报告 · 阶段 1/2

- 候选：`794c04968859b952fd222631c9564f9ea648edc5`（服务 inspection-api，`AIDH_SERVICE_INSPECTION_API_URL`）
- 测试计划：`tasks-qa.md` version 3，指纹 `sha256:06f424c4a8e03e932c5b87c0358dbd80f7a05c457e0e730b26e15846e449e231`（已核对：tasks-qa.md + runtime/qa-run.sh + runtime/qa-phases.json 内容的 SHA-256 与锁定指纹一致）
- 执行：锁定的 `runtime/qa-run.sh`，`QA_PHASE=1`、`QA_PHASES=2`；脚本退出码 0；结果 `qa-result.json`，控制台输出 `qa-run-console.log`
- 跨阶段状态：已写入 `QA_STATE_DIR/qa-state.json`（D1～D5、D16 的查询结果与运行标记，不含令牌）

## 场景结果（阶段 1）

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| IQA-001～IQA-017 | 全部通过 | `IQA-001.json`～`IQA-017.json`、`IQA-008-late.json` |
| IQA-021（删除前步骤） | 通过 | `IQA-021-phase1.json` |
| IQA-018、IQA-019、IQA-020、IQA-021（删除后步骤） | 属于阶段 2，本阶段未执行 | — |

产品缺陷 0 条，测试缺口 0 条。入口与字段发现见 `discovery.json`。

## 验收标准（本阶段验证）

| 验收标准 | 结果 | 依据场景 |
| --- | --- | --- |
| AC-01 | 通过 | IQA-001、IQA-002、IQA-003 |
| AC-02 | 通过 | IQA-003、IQA-004、IQA-010、IQA-017 |
| AC-03 | 通过 | IQA-004、IQA-005 |
| AC-04 | 通过 | IQA-006 |
| AC-05 | 通过 | IQA-007 |
| AC-06 | 通过 | IQA-008、IQA-009、IQA-010 |
| AC-07 | 留待阶段 2（IQA-018，需受控重新部署） | — |
| AC-08 | 留待阶段 2（IQA-019、IQA-020；IQA-014 已在本阶段通过） | — |

依赖假设：A-1～A-7（接口细节，实际采用 `recordId/deviceId/storeId/conclusion/note/inspectorId/submittedAt`，结论取值 NORMAL/ABNORMAL）、A-8（±120 秒时钟偏差）、A-9（空设备查询）、A-10（持有人标识已注入，按 `QA_INSPECTOR_1_HOLDER` 判定）。

人的决定（G2 答复，供阶段 2 使用）：`QA_SERVICE_LOG_URL` 不提供（IQA-019 按测试缺口处理）；I2 在两个阶段之间不删除（IQA-021 删除后步骤按测试缺口处理）。

## 下一步

请求平台受控重新部署同一候选，随后执行阶段 2（IQA-018、IQA-021 删除后步骤、IQA-019、IQA-020）。
