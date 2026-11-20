# G3 独立测试报告 · 阶段 1/2（重新执行）

- 候选：`dcebed69cba1927b21dd3f7fa3561472c528c1be`，服务 `inspection-api`（`AIDH_SERVICE_INSPECTION_API_URL`，健康）
- 测试计划：version 3，指纹 `sha256:06f424c4a8e03e932c5b87c0358dbd80f7a05c457e0e730b26e15846e449e231`（锁定，未修改）
- 执行：按人的指示从第 1 阶段重新执行；平台提供 `QA_PHASE=1`、`QA_PHASES=2`、`QA_STATE_DIR`。在空临时目录中用 `bash` 执行锁定的 `runtime/qa-run.sh`，退出码 0。
- 脚本结果：`qa-result-phase1.json`（本目录），阶段 1 的 18 个场景全部通过，产品缺陷 0，测试缺口 0；IQA-018、IQA-019、IQA-020 属于阶段 2，未执行。
- 跨阶段状态：D1～D5、D16 的查询结果与运行标记已写入 `QA_STATE_DIR/qa-state.json`（不含令牌）。
- 机密检查：证据目录、状态文件与脚本输出中未出现任何注入的令牌或数据库口令原文（逐值检索命中 0）。

## 本阶段验证的验收标准

| 验收标准 | 覆盖场景 | 结果 | 证据 |
| --- | --- | --- | --- |
| AC-01 | IQA-001、IQA-002、IQA-003 | 通过 | IQA-001.json、IQA-002.json、IQA-003.json |
| AC-02 | IQA-003、IQA-004、IQA-010、IQA-017 | 通过 | IQA-003.json、IQA-004.json、IQA-010.json、IQA-017.json |
| AC-03 | IQA-004、IQA-005 | 通过 | IQA-004.json、IQA-005.json |
| AC-04 | IQA-006 | 通过 | IQA-006.json |
| AC-05 | IQA-007 | 通过 | IQA-007.json |
| AC-06 | IQA-008、IQA-009、IQA-010 | 通过 | IQA-008.json、IQA-008-late.json、IQA-009.json、IQA-010.json |

身份与角色场景 IQA-011～IQA-016 及 IQA-021 删除前步骤均通过（IQA-011.json～IQA-016.json、IQA-021-phase1.json）。

## 留到阶段 2

- AC-07（IQA-018）：需在受控重新部署后验证，本阶段请求受控重部署。
- AC-08（IQA-014 已通过；IQA-019、IQA-020 在阶段 2）。按 G2 人的决定，服务日志导出地址 `QA_SERVICE_LOG_URL` 不提供，IQA-019 按测试缺口处理；I2 在两个阶段之间不删除，IQA-021 删除后步骤按测试缺口处理。

## 依据的假设

所有场景依赖测试计划假设 A-1～A-7（接口入口、令牌出示、字段名、结论取值、状态码判定、记录标识、查询响应形态）；IQA-001/003/014 另依赖 A-10，IQA-003/004 依赖 A-8，IQA-008/017 依赖 A-9。实际发现的入口与字段见 `discovery.json`。
