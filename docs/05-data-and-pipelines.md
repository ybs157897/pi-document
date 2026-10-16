# 数据模型、处理流水线与一致性

所有表结构与算法参数为待实施设计。PG 为业务资料事实源，Pi 为执行事实源，blob 为内容事实源。三者不假装存在分布式事务。

## 1. 数据表与约束

| 表/对象 | 关键字段、唯一约束与职责 |
|---|---|
| principals / api_credentials | tenantId、principalId、scopes、allowedKbIds、tokenHash、revokedAt；明文令牌不入库 |
| knowledge_bases / kb_members | tenantId、kbId、name、embeddingProfile、ACL revision；kb访问权在服务端解析 |
| documents | tenantId、kbId、documentId、title、tags、sourceType、activeVersion、activeGeneration、revision、deletedAt |
| document_versions | documentId、version、sourceBlobId、sha256、mime、size、sourceUri、createdBy、createdAt；内容不可变 |
| index_generations | generationId、documentId、version、parser/chunker/tokenizer/embedding配置哈希、state、error；ready后才可发布 |
| chunks / embeddings | generationId、chunkId、ordinal、text、tokenCount、sourceLocator、lexicalTokens、embedding；chunk唯一键含generation |
| blobs / uploads | blobId、tenantId、sha256、storageKey、size、referenceCount；uploadId绑定主体、KB、有效期 |
| requests | tenantId、principalId、operation、requestId、payloadHash、taskId、resultRef；作用域内唯一 |
| a2a_contexts / a2a_tasks | contextId、taskId、principal绑定、conversationId、submissionId/internalTaskId、status、revision、resultRef、parentTaskId、resourceRefs |
| processing_receipts | operationId、stage、inputHash、status、outputRef、attempt、lease/fence、errorClass；输入版本唯一 |
| outbox | eventId、aggregateId、revision、type、payload、deliveredAt；只负责可靠投递与修复，不另行执行模型任务 |
| audit_log | actor、resource、operation、requestId、outcome、timestamp；不记录全文 |

embedding 按 profile/维度建表或分区；一个索引中的向量维度与模型版本固定。标签和来源元数据建立索引。外部不直接访问数据库，ACL 条件由统一 repository 层强制加入。

自然语言工具的写入operationId由宿主从外部taskId、当前messageId、操作类型、KB/文档目标及规范化内容hash派生并持久化；不让模型生成一个新requestId绕过去重。同一轮重复调用相同写意图返回同一receipt；明确的后续消息形成新意图，同时仍校验expectedVersion。Pi工具taskId用于恢复关联，不能单独作为跨模型重试的业务幂等依据。

Pi DocFamily 只放运行需要的小状态，如 task映射、当前步骤、主体引用、预算、请求键；长文本通过有界读取工具进入上下文。持久化 schema 带版本，迁移失败应停止接单，不能清空状态重来。

## 2. 保存流程与可观测状态

业务状态：`received → stored → parsing → chunking → embedding → indexing → ready`；分支为 `failed / canceled`。这些是业务状态，不直接冒充 A2A 协议枚举。

1. 验证请求 Schema、主体 scope、知识库 ACL、大小与文件类型。先建立 requestId 收据；相同键相同 hash 重放已有任务，相同键不同 hash 返回 `IDEMPOTENCY_CONFLICT`。
2. TXT/MD、uploadId 或 URL 形成不可变 blob。使用临时文件写入、校验、原子 rename/对象提交，再入库关联；未关联对象由带 grace period 的 GC 回收。
3. PG 单事务创建 document/version、ingestion task投影、outbox；此时文档为 stored，搜索不可见。采用客户端 `requestId` 作为幂等键，不按相似标题擅自去重。相同内容可复用 blob，但跨租户不暴露去重结果。
4. dispatcher 用稳定身份提交 Pi task/Submission并写映射；先记 admission intent，再提交，再回填收据。若崩溃在提交与回填之间，重启按稳定键重获同一工作。Pi自定义task需在Pi事务内按DocFamily标记实现“若不存在才创建”，不能假定自带requestId参数。
5. parser 输出 normalizedText + source spans + warnings；文本型 PDF 保留页码，DOCX保留标题/段落序号，MD保留标题路径/行范围，URL保留规范来源/抓取时间/内容哈希。禁止解析为空仍标 ready。
6. chunker 先按标题/段落切分，再按真实 token 上限切分；初始建议目标512、上限768、重叠64 tokens，具体值纳入检索评估。表格保留表头上下文；原文偏移不能以模型改写后的文本计算。
7. 对每个chunk生成embedding；以tenant + contentHash + embeddingProfile做缓存键。批次限流，429/5xx/网络暂时故障指数退避加抖动，最多5次且总时长≤10分钟；鉴权、格式和维度不符直接失败。
8. 写入未发布generation的全部chunks、词法与向量数据，核对数量/维度/hash。PG单事务把generation置ready、CAS切换activeVersion/activeGeneration，并记录完成outbox。
9. A2A任务只有在阶段结果提交后才能completed，artifact返回document/version/generation、indexState及警告。Pi或A2A观察者收到通知较晚不会让业务重复执行。

### 取消语义

取消前验证task归属并写入取消意图。外部模型调用可能无法撤销；停止后续阶段并在每次提交前检查generation/revision fence。发布事务与取消事务通过行锁串行化：取消先提交则禁止发布；发布先提交则返回已经完成，不声称撤回保存。取消 A2A stream 或断开HTTP只取消等待，不能自动取消任务。

### 外部副作用窗口

模型/解析调用可能在“外部成功、本地未记收据”时重复发生，因此目标是**业务结果有效一次**，不承诺网络请求或付费调用 exactly-once。确定性内容键、chunk upsert、发布CAS、任务绑定及append-only receipt保证不重复发布。供应商提供幂等键时使用，否则记录不可消除的重复计费风险和预算上限。

## 3. 检索与引用

1. 从认证身份取得可读知识库集合，验证filters，拒绝未经授权的显式ID。固定这次检索的查询/索引profile和ACL revision。
2. query规范化与中文分词；词法召回和向量召回各取候选，初始各50，最大各200。只召回active且ready的generation，排除deleted，KB/标签过滤在召回SQL内执行。
3. 用 `RRF = Σ 1/(60 + rank_i)` 合并。此公式不把两种原始分数解释为可比置信度；去除完全重复片段，保留多个相关来源。
4. 配置了Reranker则对融合后的前30条重排。未配置或失败时返回 `degraded=true` 和reason；Embedding不可用可显式降级lexical，若词法也失败则task失败，不能伪装为零结果。
5. 截断topK（默认10、最大50），按响应字节/片段token预算返回snippet。结果含documentId/version/generationId/chunkId/title/locator/sourceUri、scoreType/rank及授权内容读取URI。score不是概率。
6. 输出前复核ACL/删除状态，防止查询中途撤权。已发布的新版本在下一次请求生效；同一响应中每条结果固定版本，读取引用时必须携带版本，绝不默默指向更新后的正文。

`sourceLocator`为有标签的联合类型：`pdf_page{page,startOffset,endOffset}`、`text_span{startLine,endLine,startOffset,endOffset}`、`docx_paragraph{headingPath,paragraphIndex}`、`html_section{headingPath,fragment}`。偏移基于对应版本的规范化文本，统一以Unicode码点计数，采用[startOffset,endOffset)；行号/页码从1开始，paragraphIndex从0开始。PDF偏移在该页文本内；反向映射保留原始blob hash。结构校验之外必须检查end≥start及范围未越界。不保证所有格式都有页码；UI与调用者不得伪造。

P1 `document.answer`在检索后把有限证据提供给Pi；生成结果与检索结果分开。答案需返回citationId→chunk/version映射，未支持的断言不得标为有证据。

## 4. 更新、删除与并发

更新必须携带expectedVersion，事务验证后生成新version并后台建新generation；构建失败保留旧activeGeneration。发布时再次CAS，若版本已变化则标冲突或superseded，不覆盖较新的发布。支持同时重建索引配置而不修改源内容版本。

删除先PG事务写tombstone与revision、撤销新下载并写审计/清理outbox。**删除完成指逻辑不可访问**；结果显式带purgeState=pending。旧引用统一404/410或403（按信息泄露策略），包括缓存与历史搜索结果。物理清理最迟24小时（初始建议，可配置）；有保留策略的备份清理另列，不承诺删除主库即删除离线备份。

保存、索引重建、删除与ACL修改都检查revision/fence。分页使用稳定cursor与资源版本，避免用offset导致并发写入重复/漏项；cursor签名并绑定主体/过滤条件，有效期和过期错误固定。

## 5. 重启与跨存储修复

启动先恢复Pi，再逐项对账：PG pending outbox→查Pi admission收据→复用/提交；Pi已终结但PG未投影→从提交的应用receipt重建task结果；孤儿临时blob/generation→按grace period清理；过期processing lease→带fence重试。所有修复可重复运行。

外部task生命周期以PG协议投影对外，Pi内部结束只是证据之一。领域receipt未证明发布或检索结果落库时，不能仅因模型说“完成”就把A2A改成completed。恢复逻辑不解析自然语言回答来认定保存成功。

## 6. 默认资源限制（待M0校准）

P0文件50MiB、单次内联文本256KiB、解压后200MiB、PDF最多500页、HTTP抓取30秒、parser单文件120秒、模型总预算单任务可配置、每主体同时2个ingestion、全局8个处理步骤、search topK≤50。超限明确失败，不静默截断后宣称全量保存。

上传对象1小时未消费可清理；幂等收据至少保留30天，保留期内taskId稳定。超过保留期的重试策略必须文档化；SDK提醒调用方保存documentId，不能把过期requestId视为永久去重凭据。
