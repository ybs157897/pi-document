# 实施与验收报告

本轮将规划包实现为可独立启动的 Pi Durable + A2A 文档服务。WeKnora 已克隆并固定 `2fbfb4471581cd5e7d731bc7a2d443fe7d8e95b5`，没有启动或代理它的服务，也没有复制它的业务代码。实现交付分支为 `codex/document-agent-runtime`，尚未部署到公网。证据记录的是提交前的本地验收快照。

**本地 P0 验收通过：AC-01 至 AC-26 均有对应证据；独立 P1 AC-29 管理 UI 也已通过。** 最新 `npm test` 137项、0失败，另完成30次SIGKILL恢复。此结论限于本报告列明的模型、平台与功能范围。机器可读 [AC 状态](../evidence/final/acceptance.json) 分列 P0 AC-01 至 AC-26 和独立 AC-29，固定环境见 [manifest](../evidence/m0/manifest.json)。AC-29 不计入 P0 范围，也不表示其它 P1/P2 已完成。不能将实现存在、确定性测试和真实模型质量混为一项证明。

## 已实现

- 官方 Pi Durable 1.3.0 与 SQLite 持久任务；PG 业务收据/outbox、context 映射、进程独占及数据库 owner 锁，重开后恢复。
- A2A 1.0 JSON-RPC、Agent Card、Send/Get/List/Cancel/Subscribe、真实 SSE；DataPart 业务接口和自然语言 TextPart。
- 知识库 create/list；文档 save/get/list/search/update/delete；上传和安全 URL 来源，原文字节 hash、解析与分块 locator。
- TXT/MD/PDF/DOCX/HTML、中文 PDF CMap；PG 全文 + pgvector cosine、RRF、显式 Embedding/Rerank 降级。
- staging/active generation、v1→v2 CAS、tombstone、异步 purge；旧版本/旧任务/旧引用按当前权限检查。
- 自然语言工具意图和 action 收据、同 task 澄清续传、context FIFO、取消 fence、真实模型预算。
- 主体 token、KB ACL、上传/任务/模型并发限制，脱敏访问日志、租户管理员 metrics、状态审计。
- 独立客户端、离线三存储备份/恢复/对账、管理员 token 轮换和撤权。

具体启动与配置见 [README](../README.md)，客户端见 [接入示例](../examples/clients/README.md)，备份限制见 [运维手册](operations.md)。

## 证据与范围

| 验证面 | 证据 | 可以得出的结论 |
|---|---|---|
| 干净安装 | [clean-install](../evidence/m0/clean-install.json) | 临时空目录 npm ci、真实 Pi SQLite open/close；依赖审计 0 告警 |
| 产品检查 | [测试结果](../evidence/final/product-tests.json)、[日志](../evidence/final/product-tests.log) | 合同、Pi、协议、解析、PG/pgvector、权限、生命周期与备份的实际测试结果 |
| 外部调用方 Pi Agent | [caller-agent](../evidence/m4/caller-agent.json) | qwen3.8-flash 真实选工具并执行保存、检索、读回；不是预制模型输出 |
| 服务自然语言入口 | [natural-live](../evidence/m4/natural-live.json) | 以文件中的运行状态为准，检查真实 action 收据、重复消息和撤权 |
| SDK/原生 HTTP/Python | [live-service](../evidence/m2/live-service.json) | 真实 Embedding、保存/索引/检索/引用/更新/撤权链路 |
| 故障恢复 | [24次](../evidence/m3/crash-matrix.json)、[取消/删除6次](../evidence/m3/cancel-delete-crashes.json) | 10 个窗口标签各 3 次真实 SIGKILL/reopen；故障时外部 Embedding 为确定性 HTTP fixture |
| 独立资料复核 | [fixture-review](../evidence/evaluation/independent-fixture-review.json) | 冻结文件 hash、110 份版本来源与 154 处标注支持段落独立解析复核 |
| 检索评估 | [评估说明](../evidence/evaluation/README.md) | 冻结100文档、100查询，20%盲集；失败运行保留，最终运行见 [完整结果](../evidence/evaluation/retrieval-2026-10-16T05-13-53-360Z-156014/report.json) |
| 性能 | [10分钟](../evidence/performance/load-10min.json)、[尺寸回归](../evidence/performance/indexing.json) | 固定并发和语料下的真实延迟；不能推断峰值吞吐或生产SLA |
| 三存储恢复 | [backup-restore](../evidence/m4/backup-restore.json) | 备份后修改源状态，再恢复到空目录/新数据库，原task与引用读回、新写成功 |
| AC-29 管理 UI 浏览器检查 | [browser.json](../evidence/ui/browser.json)、[最终 retry](../evidence/ui/retry-final.json)、[未知提交恢复](../evidence/ui/malformed-response-recovery.json)、[知识库](../evidence/ui/desktop-library.png)、[检索引用](../evidence/ui/search-citation.png)、[失败任务](../evidence/ui/failed-index-task.png)、[权限](../evidence/ui/access-control.png)、[移动端菜单](../evidence/ui/mobile-menu.png) | 33项浏览器检查通过：建库、上传/索引、原文字节下载、检索locator、权限撤销、v2、删除、任务筛选与28项分页；5次503后真实Embedding恢复generation ready，语义搜索命中原文v1且没有重复版本；未知提交和异常响应恢复同requestId/task，375px页面宽度无溢出。AC-29单独验收通过，不计入P0 AC数量 |

故障标签 `outbox-handled` 使用 Pi commit 后、PG ack 前的窗口，与 `pi-admitted` 边界重合；报告保留该事实。所有测试均在 loopback、临时数据库、独立 Pi SQLite/blob 中运行。未做主机断电实验，也不宣称外部模型调用 exactly-once 或零重复计费。

## 模型、质量与性能口径

生成模型为用户指定的 `qwen3.8-flash`，Embedding 独立固定为 `qwen3.7-text-embedding-flash`、1024维、L2、profile version 1。Rerank 未配置；真实检索报告保留 `reranker_not_configured`。供应商 token/请求量可计数，未核实币种单价，不能把测试成本写成零。

质量只在 85 条有答案且有权的查询上计算文档级宏平均，重复 chunks 不重复计命中文档；10 条无答案的误报、5 条权限拒绝单列。语料是合法合成样例，不是企业资料分布，也不是与原版 WeKnora 的同预算对照。HTML 20份固定快照使用 upload 管线，公网 URL 抓取由单独真实 example.com 与 SSRF 测试覆盖。

负载语料为 10,000 个重复公共段落，5 个客户端按每秒一轮 keyword + hybrid 持续10分钟；同一内容的入库 Embedding 可命中缓存，查询使用真实接口。尺寸回归各5次：500 KiB MD 含128段重复内容，10页 PDF 每页46行。其 p95 等于小样本最大值，不代表所有同尺寸文档。


## 最终实测值

| 指标 | 结果 |
|---|---|
| 质量分母 | 85条有权且有答案查询，100条查询全部执行 |
| Recall@10 / MRR@10 | 1.00 / 1.00，语言/格式/类别/固定盲集分组均公开 |
| 标注支持段 / 引用映射 | 105/105 / 927/927 |
| HTML快照 | 20/20 上传、索引、原文hash与locator通过 |
| 无权限查询 | 5/5拒绝，0泄漏 |
| 无答案查询 | 10/10仍返回相似候选；未实现回答拒答，不能把候选当成有依据答案 |
| 10分钟负载 | 10,000 chunks、5客户端；keyword/hybrid各3,000次 |
| keyword / hybrid p95 | 131.7 ms / 345.9 ms；hybrid含真实Embedding，未启用Rerank |
| 500 KiB MD / 10页PDF索引 p95 | 9.07 s / 2.14 s，各5份合成尺寸样本 |
| SIGKILL重启 | 30/30正确收敛；24个通用窗口运行中的最大ready时间1.17秒以内 |
| 真实自然语言 writer | qwen3.8-flash，4次模型请求、3次工具调用：save/search/get |
| 本机服务 | http://127.0.0.1:4328；health/readiness与管理员metrics均200 |

## 交付边界

- P0 服务核心与独立 P1 AC-29 管理 UI 均已通过本地验收，但不等于 WeKnora 全量复刻。OCR、复杂表格、`document.answer`、同步/Wiki/图谱和多节点仍未实现。
- PDF/DOCX/HTML worker 在 macOS 使用进程级网络 deny，实测本地 TCP 被拒而父进程仍可连接。其它平台 fail-closed；这不是文件系统沙箱，也未部署 Linux 容器隔离。
- 分块固定 768 UTF-8 bytes、64 bytes overlap，属于 byte-fallback 的保守上界，不称为精确 Qwen tokenizer。
- 服务仅绑定 loopback，生产 TLS/SSO、公开部署、容器镜像、多机运维尚未验收。
- 备份依赖停止全部写入。三存储不是一个分布式事务；未验证掉电零丢失、在线 PITR 或所有历史 natural 会话的完整灾备。
- 原版 WeKnora 对照为 `not_run`；不能声称同等检索质量。未运行官方 A2A TCK，不宣称全规范认证。

## 运行预算

领域任务执行并发8，活跃任务总量128/租户64/主体32，每主体同时最多2项 ingestion；自然任务并发默认8（可配1–16），待处理turn总量128/主体32，上传并发全局8/主体2。超量请求返回可重试的明确错误，幂等请求先复用已有收据。

`TASK_MAX_DURATION_MS` 默认15分钟、最多15分钟，从领域任务持久化创建时间计算，重启不重置；到期不能发布generation。自然turn从开始处理起默认120秒，可通过 `NATURAL_TURN_TIMEOUT_MS` 向下调整。`NATURAL_MAX_MODEL_REQUESTS` 最多8、`NATURAL_MAX_TOOL_CALLS` 最多20，生成单次输出由受信任profile的 `maxOutputTokens` 控制。Embedding单请求超时30秒、每批最多5次有界重试；入库批次最多8条，已完成批次/向量缓存可复用。未提供按币种计费的供应商账单硬限额。

## 验收中修复的问题

10,000 分块暴露了单条 SQL 超过 PostgreSQL 65,535 参数上限，现改为每批1,000行、同事务发布；带标签的 v2 更新曾把 JavaScript 数组交给 PG array 编码，现显式 JSON 编码。自然 action 子任务现由 natural runtime 独占派发与恢复，避免通用 pending pump 在取消围栏前抢跑。

查询词法召回原先要求用户问题的所有分词同时出现，导致“请查询编号…”中的措辞阻断匹配。普通词法查询保留合取的精度，语义召回负责自然语言表达；包含数字的复合编号（如 `ABC-123`）保持编号组成项的合取，避免仅凭共同数字后缀误召回，编号查询去掉会阻断匹配的提问措辞后，再与向量排名做 RRF。索引分词、ACL、原文、冻结查询和质量阈值均未修改。

评估过程保留失败运行；评估器的文档级排名、支持段覆盖与引用正确性分开报告，不能通过缩小失败查询分母抬高分数。冻结盲集曾在全量回归中执行，后续实现修复后的同一盲集结果应理解为固定回归分组，不等同于重新采集的独立未见测试集。

词法策略修正采用通用编号识别，不匹配任何评估专用编号前缀。曾试验普通词项的 OR 召回，发现会把只共享地名/标题的分块加入融合、挤掉直接支持段，因此保留普通词项的严格匹配，只调整复合编号处理；对应失败结果仍保留。

自然工具按 text/upload/url 拆分 source 参数，避免真实 Qwen 将嵌套对象生成为 JSON 字符串；A2A 领域 Schema 仍严格校验。对于“读回刚保存文档”，仅在同一 task、同一 KB、唯一成功保存收据且用户未点名另一个文档时绑定该收据的 ID。Pi 记录保留原模型参数，domain action 与工具结果记录实际绑定来源；没有通用 UUID 猜测或错误目标替换。

自然删除成功后返回固定安全收据并关闭该 context，取消同 context 排队 turn，不再把旧正文送入模型。旧内容任务保持隐藏；继续使用旧 context 会返回 `CONTEXT_CLOSED_REQUIRES_NEW`，需用新 context 开始新请求。取消自身读取任务不要求写权限；写操作的明确意图检查也识别否定和只读前缀。
