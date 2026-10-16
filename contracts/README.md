# 契约文件说明

这些文件说明当前 A2A DataPart 业务合同。管理界面使用的 `/api/manage/*` 是同源 HTTP 管理 API，不属于 `Part.data` Schema；路由与权限边界见 [管理 UI 使用与边界](../docs/12-management-ui.md)。

- `document-request.schema.json`：A2A `Part.data` 内的业务请求；JSON Schema Draft 2020-12，包含P0操作与标明为P1的 `document.answer`。
- `document-result.schema.json`：Task Artifact的业务结果；`outcome` 区分业务成功/失败，不能覆盖A2A Task状态。
- `examples/a2a-*.json`：A2A v1.0的Agent Card、保存/检索请求与结果、stored落盘回执及后续索引任务GetTask/CancelTask样例；示例域名、ID和时间均为fixture。
- `examples/payload-*.json`：纯业务payload，可以嵌入 `Part.data`，不是完整A2A请求。

## 请求规则

一个 `SendMessage` 业务请求P0只包含一个业务DataPart。若有多个互相冲突的业务DataPart，返回参数错误；自然语言TextPart走独立Pi Agent路径。TextPart不能覆盖同时存在的结构化DataPart的scope/参数，P0混合两种指令形式直接拒绝，避免隐式优先级。

`schemaVersion` 是应用合同版本，和A2A wire version不同。所有业务请求要求requestId；自然语言请求如无此字段，由服务端按principal + contextId + messageId建立独立幂等收据并保存payloadHash。认证身份来自服务端；Schema拒绝未经定义的tenantId、principalId等字段。

Schema中的default不会被JSON Schema自动填入，应用验证后显式补默认值再计算语义payloadHash。hash采用稳定JSON键排序后的规范请求，包含operation、KB和完整input；不包括传输id与访问令牌。不同隐式默认与显式同值应视为同一语义请求，版本/默认值改变必须在合同升级时处理。

`source.kind=text`缺省mimeType固定为`text/plain`，解析与payloadHash均先补该默认值。`document.save`省略tags视为空数组；`document.update`省略tags保留旧标签、传空数组清空、传非空数组整体替换（不隐式合并）。update省略title保留旧标题；source必填，P0不提供独立纯元数据patch。

所有长度还需验证UTF-8字节、实际token与解压后大小；Schema的maxLength是字符约束，不能替代资源限制。URL格式校验不能替代DNS/IP与重定向的SSRF检查。locator还需验证end>=start、offset未越界、与原版本hash相符。

## 结果规则

- `save/update`：成功结果的`indexState`只允许`stored`或`ready`。`stored`表示仅完成原文落盘（对应`waitFor=stored`），必须带独立`ingestionTaskId`；它是服务端创建的公共A2A task ID，可用标准GetTask/SubscribeToTask/CancelTask查询或取消，绝不是Pi内部taskId。该任务绑定同一principal/context/文档版本，并与已完成的父落盘任务通过`parentTaskId`关联；父任务不再改回working。`ready`表示索引已发布，必须带`generationId`。解析/切块/Embedding/索引中的进度通过任务状态查询；失败或取消不能作为成功结果的`indexState`。
- `get`：返回固定版本source hash、有限content、truncated/nextCursor。请求 `input.limit` 为1至16,384个Unicode code point，缺省100；调用方可选择更小分页。`downloadUri`不是宿主机路径。
- `list`：返回文档摘要和可选nextCursor，cursor过期/不匹配使用明确错误。
- `search`：results为空是正常成功；scoreType说明排序来源，不表示真实性概率。降级必须提供degradationReason。
- `delete`：deleted=true表示逻辑不可访问，purgeState明确物理清理是否完成。同一requestId重放原结果；新requestId删除已删除资源返回DOCUMENT_NOT_FOUND，不泄露删除历史。
- `knowledge_base.create/list`：只返回调用方有权限的KB；P0不宣告KB更新/删除接口。
- `answer`：P1；未实现前不得放入Agent Card skills，也不能通过Schema验证就当作可用。

## 管理 API 与界面

Web界面由同一服务在 `/ui/` 提供，Bearer token 通过 `GET /api/manage/me` 验证。管理API每次请求重新认证并从认证主体绑定tenant；不接受客户端传入 `tenantId`，管理响应均为 `Cache-Control: no-store`，不返回token hash或模型密钥。创建主体时，明文token仅在创建响应中返回一次。

`GET /api/manage/knowledge-bases/:id/permissions` 对普通主体返回当前主体的有效权限，即全局scopes与该KB membership grants的交集；管理员返回全部KB scopes。管理员 `/members` 列表保留原始grants，以便管理授权配置。`POST /api/manage/tasks/:id/retry` 只接受 `{requestId}`；结果不确定时必须复用同一requestId才可幂等重放。重试仅适用于当前主体仍有写权限、源版本有效且服务标记为可重试的失败保存/索引任务，不是通用任务重跑接口。

## 稳定业务错误

| code | 阶段/处理 |
|---|---|
| IDEMPOTENCY_CONFLICT | 接单前相同requestId不同语义payload；不可自动换键重试写入 |
| VERSION_CONFLICT | expectedVersion不符或发布CAS冲突；重新读版本后由调用者决定 |
| DOCUMENT_NOT_FOUND / KNOWLEDGE_BASE_NOT_FOUND | 不存在、已删除或不可见资源；避免存在性泄漏 |
| INVALID_UPLOAD / UPLOAD_EXPIRED | uploadId非本主体、过期、校验不符；不返回其他主体信息 |
| UNSUPPORTED_FORMAT / EMPTY_DOCUMENT / PARSE_FAILED | 格式/内容问题；明确可否由用户更换来源后重试 |
| LIMIT_EXCEEDED / BUDGET_EXCEEDED | 大小、时间、页数或模型预算超限；不能静默截断 |
| SOURCE_FETCH_DENIED / SOURCE_FETCH_FAILED | 安全策略拒绝不重试；暂时网络失败可有界重试 |
| EMBEDDING_FAILED / INDEX_FAILED / RETRIEVAL_FAILED | 分类提供retryable；不伪装成空命中 |
| CURSOR_EXPIRED / INVALID_CURSOR | 重新开始分页；不能复用另一个主体/过滤条件的cursor |
| INTERNAL_ERROR | 通用公开错误，内部原因只写脱敏trace，不泄露凭据/正文 |

接单前的业务参数错误放在规范JSON-RPC错误details中；已接单任务的错误进入TASK_STATE_FAILED及业务error结果。认证失败在HTTP层处理。A2A标准错误码与业务code分开，细节见 [A2A合同](../docs/04-a2a-contract.md)。

## 兼容与验证边界

Schema检查能验证业务payload形状，不能验证A2A外壳、SDK路由、认证、状态机或实际能力。示例已使用锁定SDK、原始HTTP客户端和Python客户端验证协议表面；未运行官方A2A TCK，不宣称完整A2A v1.0.1一致性认证。

新增字段优先走显式合同版本；不得静默放开additionalProperties让客户端误以为功能可用。实现时为成功、失败及所有操作补充独立fixture，最终契约测试与运行测试均以07验收标准为准。
