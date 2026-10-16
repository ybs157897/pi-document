# 分阶段实施计划

本文件为执行计划。**当前实现状态：M0 基线已完成；M1–M4 的代码实现与本地P0验收已完成，质量、性能与真实自然语言证据见最终报告；M5/M6 尚未开始。** `implemented` 不等于阶段退出门槛或对应 AC 已 `passed`，逐项验收状态以 [验收状态与证据](07-acceptance.md) 和最终报告为准。M0 技术基线见 [M0 实施记录](10-m0-implementation.md)。复杂度按相对规模标记 S/M/L，不用未经验证的日期承诺代替阶段验收。按 M0→M1→M2→M3→M4 顺序交付 P0；M5/M6 为扩展。

## M0：锁定基线与技术试验（M）— `implemented`，基线完成

**输入**：本实施包、实际部署环境、允许使用的模型配置。

1. 在本仓库建立应用工程（Git 仓库已经由规划发布阶段建立，无需再次初始化），确定Node LTS精确版本、包管理器、锁文件、Pi/Chord/Pi-AI和A2A SDK精确版本，保存source manifest。
2. 把04的A2A版本与SDK做兼容试验：AgentCard discovery、send/get/cancel、至少一条真实stream。根据契约生成类型并检查样例，禁止混合不同协议字段。
3. 做真实Pi SQLite reopen + resume + 自定义task + 工具副作用收据试验；证明取消等待不会取消任务。验证多进程打开策略和数据库持久性配置。
4. 对TXT/MD/PDF/DOCX/HTML各用正常/空/损坏/超限样本核实parser及source spans。选择并锁定解析器及许可证；如果借用WeKnora组件，记录目录、SHA、修改与原许可证。
5. 用至少20条中文精确词/编号/同义表达试验中文分词、PG lexical、Embedding维度与Rerank接口，确认模型认证、超时、费用和配置读取方式。

**交付**：依赖lock、可重跑spike脚本、实际输出与决定记录、更新后的契约；不把一次curl 200作为A2A兼容成功。

**退出门槛**：AC-01、02对应的基线试验通过；此时不将完整AC-02跨客户端业务链路或AC-03独立运行提前判定通过，完整验收留在M4。协议不兼容、格式丢引用或SQLite恢复不成立必须先修正设计。不要在此之前铺满功能代码。

## M1：最小持久化垂直切片（L）— `verified_local`，本地验收通过

建立 `src/{config,a2a,runtime,domain,storage}` 和数据库迁移。实现令牌身份/知识库ACL、最小知识库create/list、blob接口、request收据、Pi任务绑定与outbox reconciliation。

首条链路：其他Agent → A2A document.save(text) → Pi durable task → blob/PG → document.get。实现同键重试、同键异参冲突、重启后原task可查。所有任务/artifact按当前请求主体鉴权。

**交付**：单服务本机启动、持久化compose配置、迁移、合约测试与两身份fixture。

**退出门槛**：AC-04、05、06、14、18、20通过；尚无索引时不允许返回waitFor=indexed成功。

## M2：解析、索引、检索闭环（L）— `implemented`，固定语料质量与性能已本地验证

实现source接入、上传API、URL fetch、解析隔离、source locator、chunker、embedding批次、词法/向量召回、RRF与rerank降级、generation发布、search/get/list与结构化artifacts。

按04合同补齐错误码；实现资源限额与引用读取授权。只把active/ready内容加入搜索，保留阶段状态。为parser/embedding输出建立阶段收据，覆盖失败重试。

**交付**：支持格式矩阵、独立检索评估集、指标脚本、完整保存→检索→引用演示。

**退出门槛**：AC-07至13、15、22、23通过；解析空内容或Embedding失败不得作为成功保存索引。

## M3：版本、删除、恢复、并发（L）— `implemented`，本地故障恢复门槛已验证

实现expectedVersion/CAS、重建generation、tombstone/清理、稳定分页、ACL撤销后的结果过滤。补全两库崩溃窗口的reconciliation、cancel fence、限额、预算与不确定外部副作用处理。

**交付**：故障注入驱动、逐窗口恢复报告、并发更新/删除竞态证据、数据库对账命令。

**退出门槛**：AC-16、17、19、21、24、25全部通过；保存结果不重复发布、旧索引不泄漏、无终态回退。

## M4：跨 Agent 与运维交付，P0验收（M/L）— `implemented`，P0 AC-01至AC-26已通过；AC-29另行验收

完成SDK接入示例和通用HTTP客户端示例，各自以独立身份运行；至少一个真实调用方Agent使用真实模型自动选择保存/检索工具完成闭环。完善health/readiness、结构化日志、metrics、备份恢复、token轮换和README。停止WeKnora进程或在隔离环境中运行本服务，证明运行依赖独立。

**交付**：客户端接入文档、部署/升级/恢复手册、固定语料测试报告、真实模型运行证据与完整P0验收报告。

**退出门槛**：AC-01至26的全部P0门槛通过。任何未跑真实模型、故障恢复或跨Agent的门槛标 `not_run/blocked`，不得写“全部完成”。正式push/deploy另按用户授权执行。

## M5：P1能力补齐（分批M/L）— `in_progress`（AC-29 已通过，其余P1尚未开始）

- 有依据问答：Pi规划多次检索、证据聚合、citation验证、资料不足行为。
- OCR/扫描PDF/图片/复杂表格/XLSX/批量导入：独立格式fixture和结构保真评估。
- AC-29 管理 UI：同源 `/ui/` 登录、知识库/文档/任务/检索引用/主体和KB权限路径通过独立浏览器验收。5次503后的retry使用真实Embedding恢复 generation，原文v1保持唯一且语义检索命中；未知提交、失效响应恢复、删除、分页与375px视口也已验证，详见 [管理 UI 使用与边界](12-management-ui.md)。AC-29 是 P1 独立验收，不计入 P0 AC-01 至 AC-26。
- FAQ/手工知识维护、去重提示、批次回滚、rerank与索引配置管理。

门槛：AC-27至30按功能逐项通过，不以界面可见代替后端可恢复。目前 AC-29 已通过；AC-27、AC-28、AC-30 尚未开始。

## M6：P2完整产品能力与差异消除（逐项立项）— `not_started`

按01的WeKnora映射推进Wiki/知识图谱、数据源连接器、定时增量同步、完整RBAC空间/审计、Webhook/推送、多后端、UI完整体验、多节点owner分片、生态接入。每项都补输入契约、生命周期、授权和独立验收，不借用文档Agent的身份扩大通用执行权限。

“全量复刻完成”需要01所有纳入项都有运行证据；明确放弃项需用户确认，不能靠标P2永久隐去。

## 并行与文件边界

M0锁定后可并行：A负责 `src/a2a,contracts,examples`；B负责 `src/ingestion,src/retrieval`；C负责 `src/storage,migrations`；负责人负责 `src/runtime,src/app` 集成与验收。共用类型先审定，迁移由单owner串行编号。没有可独立测试的接口前不强行拆分。

每次交付报告：具体行为变化、通过的AC ID、测试环境/commit、未覆盖项和下一阶段。提交与推送只按用户届时授权，禁止把文档中的阶段安排当作自动发布授权。
