# A2A 对外契约

日期：2026-10-16。本文是待实施的协议与业务边界，示例按官方字段手工编写，尚未通过 SDK 端到端运行或跨客户端验证。

## 版本基线

建议锁定以下组合，升级时同时复核协议规范、SDK 生成类型和互操作验收：

| 项 | 固定版本 | 依据 |
|---|---|---|
| A2A 协议 | 稳定规范 `v1.0.1`；Agent Card 的 `protocolVersion` 与请求头仍写 `1.0` | 官方 A2A 仓库截至检查日最新稳定 release/tag 为 `v1.0.1`，tag commit `3303592588e388e62e0f69f701af531d2f4e3991`。A2A 的 wire version 使用 Major.Minor，不写成 `1.0.1`。 |
| JavaScript/TypeScript SDK | `@a2a-js/sdk@1.3.0`，精确锁版本；Node.js `>=20` | 官方 `a2aproject/a2a-js` 最新稳定 release/tag 为 `v1.3.0`，tag commit `29417a5bb4038f804f310ce4fffd267a9375aa90`；npm registry 当日 `latest` 也是 `1.3.0`。 |
| A2A 传输 | JSON-RPC 2.0 over HTTPS | 主实现和示例统一使用官方 SDK 的 JSON-RPC handler/client；Agent Card 可在将来额外声明其它绑定。 |

有一个明确的版本门禁：SDK 1.3.0 README 声明实现 A2A 规范 `v1.0.0`，而协议仓库当前稳定规范是 `v1.0.1`。目前没有 SDK README 对 1.0.1 的单独兼容声明，所以不能把“SDK 最新”当成“已证明与 1.0.1 互通”。实施开始时须比较两个版本的规范变更，并通过本文件末尾的 v1.0.1 互通门禁；若失败，先升级 SDK 或固定适配层，再开始业务实现。

不要混用 v0.3 和 v1.0：v1.0 JSON-RPC 方法名是 `SendMessage`、`GetTask` 等 PascalCase；v0.3 的 `message/send`、`tasks/get` 形式只属于旧协议/兼容层。v1.0 JSON 字段是 camelCase，枚举值按 ProtoJSON 使用大写名字，例如 `ROLE_USER`、`TASK_STATE_COMPLETED`。规范 §9.3 有一处通用 `category/action` 占位文字，与同节 §9.1、§9.4 以及官方 SDK 路由实现不一致；本合同按明确列出的 PascalCase 方法和 SDK 实现。

## A2A 外壳与业务数据的边界

A2A 定义发现、消息、任务、状态、Artifact、传输和错误语义；它不定义 `document.save` 等知识库业务操作。业务请求与结果使用 A2A `Part` 的 `data` 内容承载，媒体类型写在 `mediaType`。例如：

```json
{
  "data": {
    "schemaVersion": "1.0",
    "operation": "document.search",
    "requestId": "req-search-001",
    "knowledgeBaseId": "kb-project-docs",
    "input": { "query": "索引恢复", "topK": 5, "mode": "hybrid", "rerank": true }
  },
  "mediaType": "application/json"
}
```

这是 **v1.0 `Part` oneof 的 JSON 形状**：用 `data` 字段承载 JSON 值；不要加入 v0.3 的 `kind: "data"`。业务对象由本项目 Schema 约束，A2A 不会替业务对象验证字段。对于 `document.save`，请求体沿用统一根字段 `schemaVersion`、`operation`、`requestId`、`knowledgeBaseId`、`input`；`input.source` 支持文本、预先上传的 `uploadId` 或经过服务端安全策略校验的 URL，并可带 `title`、`tags`、`waitFor`。检索输入使用 `query`、`topK`、`filters`、`mode`、`rerank`。完整字段约束见 [业务请求 Schema](../contracts/document-request.schema.json) 与 [业务结果 Schema](../contracts/document-result.schema.json)。

业务操作名约定为 `document.save`、`document.search`、`document.get`、`document.list`、`document.update`、`document.delete`、`knowledge_base.create`、`knowledge_base.list`；`document.answer` 属于 P1。结果仍由 A2A Task/Artifact 包装，Artifact 中的 DataPart 采用统一业务结果根对象：`{schemaVersion:"1.0", operation, requestId, outcome:"succeeded"|"failed", result?, error?}`。保存成功至少回传 `documentId`、`version`、`indexState`、`sha256`；检索成功回传 `query`、`results`、`degraded`，命中项包含 `documentId`、`version`、`generationId`、`chunkId`、`title`、`snippet`、`locator`、`rank`、`scoreType`、`contentUri`。这些是应用 Schema，不是 A2A 标准字段。

保存和检索的请求/响应 fixture 见 [save request](../contracts/examples/a2a-document-save-request.json)、[save response](../contracts/examples/a2a-document-save-response.json)、[search request](../contracts/examples/a2a-document-search-request.json)、[search response](../contracts/examples/a2a-document-search-response.json)。这些样例 ID 是虚构值；保存样例的 SHA-256 对应请求中的精确示例文本，不代表真实服务运行结果。

`requestId` 是调用方提供的业务幂等键；A2A `messageId` 标识一条消息；JSON-RPC `id` 只把一次 RPC 请求与响应关联。三者不能互相替代。`GetTask` / `ListTasks` 查询 A2A 任务；`document.get` / `document.list` 才读业务文档。业务文档不会因为出现在 A2A Task 历史或 Artifact 中而绕开文档 ACL。

P0 同时接受 `text/plain` 的自然语言 TextPart，由 Pi Agent 调用同一文档工具。一个消息只选结构化 DataPart 或自然语言 TextPart；缺少关键知识库/目标信息时，自然语言任务可进入 INPUT_REQUIRED，并在相同taskId/contextId的后续消息中补全。鉴权失败不靠自然语言补令牌。自然语言幂等与写入意图收据见 [契约说明](../contracts/README.md)。

建议 P0 每次业务操作都创建 A2A Task 并把业务结果放入 Artifact，保持可查询的 `taskId` 与恢复点；不要对保存、检索等操作退化成没有持久 Task 的 Message-only 快捷响应。

## 发现与调用

1. 客户端通过标准 well-known URI `/.well-known/agent-card.json` 发现公开 Agent Card（本机 loopback 可用 HTTP；远程服务须在部署阶段配置 HTTPS）。若部署在代理子路径，反向代理仍需保证标准 URI 可访问，或由客户端显式配置自定义 Card URL。
2. 客户端从 `supportedInterfaces` 选择其支持的接口。首选接口示例是 `protocolBinding: "JSONRPC"`、`protocolVersion: "1.0"`，并包含真实 JSON-RPC URL。能力与每项 `skills` 描述应写明文档保存、检索、读取、列表、更新、删除和知识库操作。
3. Agent Card 用 `securitySchemes` 与 `securityRequirements` 声明认证要求。P0 本机默认使用服务生成的 opaque Bearer token；服务端只保存 token 的 hash，并将其解析为稳定 `principalId`。Agent Card 只声明 Bearer，不伪称已接入 JWT/OIDC 身份提供方。远程部署的 TLS 在后续部署阶段配置。Token 不出现在 DataPart、Pi 会话或日志中。
4. JSON-RPC HTTP 请求固定发送 `Content-Type: application/json`、`A2A-Version: 1.0` 与 `Authorization: Bearer …`。官方 SDK 在未提供 `A2A-Version` 时按 `0.3` 处理；v1.0 服务可能因此拒绝请求，所以调用方必须显式发送。A2A v1.0.1 的 HTTP+JSON/REST 绑定使用 `application/a2a+json`；它与 JSON-RPC envelope 的 `application/json` 不要混淆。DataPart 自身的 `mediaType` 仍是 `application/json`。
5. 只有当所选 AgentInterface 声明了 `tenant` 时，调用方才把完全相同的值放进 A2A 请求参数的 `tenant` 字段。该字段是路由信息，不是授权凭据，也不能允许调用方靠自报 `tenantId` 选择知识库所有者。服务端从 opaque token 解析 `principalId` 与授权后的 `tenantId`，对每次读写、任务轮询、流订阅、引用读取和下载复核 ACL。

Card 范例见 [agent-card.json](../contracts/examples/a2a-agent-card.json)。Card 中的接口 URL、Bearer 方案和 agent version 均为示意值。

## 消息、方法与任务生命周期

v1.0 JSON-RPC 端点的方法名及职责如下：

| 方法 | 用途 | 重要边界 |
|---|---|---|
| `SendMessage` | 提交一个业务 DataPart | 返回 `Task` 或 `Message`；本项目 P0 固定返回 Task。 |
| `SendStreamingMessage` | 提交并以 SSE 接收进度 | 仅当 Card 宣告 `capabilities.streaming: true` 时提供。 |
| `GetTask` | 按服务端生成的 task ID 取最新快照 | `historyLength` 可限制返回历史；对其他主体不可见的任务应按 not-found 处理。 |
| `ListTasks` | 分页列出 A2A 任务，可按 `contextId` / `status` 过滤 | 不是业务文档列表。 |
| `CancelTask` | 请求取消尚在运行的任务 | 已完成、失败、拒绝等终态不能取消；重复取消已取消任务可返回当前快照。 |
| `SubscribeToTask` | 订阅未终态任务的 SSE 更新 | 流以当前 Task 快照开始，随后是状态或 Artifact 更新；终态任务不再可订阅。 |

核心外壳形状：

```json
{
  "jsonrpc": "2.0",
  "id": "rpc-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "msg-1",
      "role": "ROLE_USER",
      "parts": [{
        "data": {
          "schemaVersion": "1.0",
          "operation": "document.search",
          "requestId": "req-search-shell-001",
          "knowledgeBaseId": "kb-project-docs",
          "input": { "query": "索引恢复" }
        },
        "mediaType": "application/json"
      }]
    },
    "configuration": {
      "acceptedOutputModes": ["application/json"],
      "returnImmediately": true
    }
  }
}
```

`configuration.returnImmediately` 是传输调用是否等待 Task 的选择；它与业务 `input.waitFor` 不同。默认/`false` 表示等待到 Task 进入终态或 `INPUT_REQUIRED` / `AUTH_REQUIRED`；`true` 表示立即返回 Task，客户端随后用 `GetTask` 或 `SubscribeToTask` 取进度。`waitFor: "indexed"` 约束 `document.save` 何时才算业务成功：在索引 generation 发布前不得把该业务 Task 标记为 `TASK_STATE_COMPLETED`。因此客户端可以立即得到 Task ID，但 Task 仍处于工作态。

P0 支持 [`SendStreamingMessage`](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md#312-send-streaming-message) 和 [`SubscribeToTask`](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md#316-subscribe-to-task)，只发送任务状态与 Artifact 的增量，不承诺逐 token 输出或断线后的完整事件重放。A2A v1.0.1 要求订阅流以当时的 Task 快照开头，后续可有状态/Artifact 更新，并在 Task 到达终态时关闭；规范和 SDK v1.3.0 都没有定义 `Last-Event-ID` 或完整 replay。客户端重连后重新订阅，以首个当前快照收敛，再消费新事件。持久化的 Task/Artifact 快照是恢复依据，不把 SSE 连接当事件日志。Push notifications 在 P0 关闭。

状态值按 v1.0.1 protobuf 定义：`TASK_STATE_SUBMITTED`、`TASK_STATE_WORKING`、`TASK_STATE_COMPLETED`、`TASK_STATE_FAILED`、`TASK_STATE_CANCELED`、`TASK_STATE_INPUT_REQUIRED`、`TASK_STATE_REJECTED`、`TASK_STATE_AUTH_REQUIRED`。`COMPLETED`、`FAILED`、`CANCELED`、`REJECTED` 是终态。`INPUT_REQUIRED` 和 `AUTH_REQUIRED` 是等待补充输入/授权的中断状态，不是终态；客户端继续同一任务时，在新 `Message` 中带回相同 `taskId` 与 `contextId`。Task ID 由服务端生成；不能用调用方业务 `requestId` 当 Task ID。向终态 Task 追加消息或订阅终态任务属于不支持操作。

### 大文件与内容引用

不把大型 PDF、DOCX 或图片以 base64 `raw` 塞进 A2A JSON。通过独立、受鉴权的 `POST /v1/uploads` multipart 直传；API 对大小、MIME、校验和、恶意内容、过期时间作限制，返回 `uploadId`、`sha256`、`size`、`mime`、`expiresAt`，之后在 DataPart 的 `input.source` 中引用该 ID。消费时服务端重新校验 uploadId 属主、授权租户、过期状态和 SHA-256，重复业务请求必须命中同一个幂等记录。不得接受本机文件路径。

URL 来源需逐跳校验重定向和最终地址，限制 scheme、DNS/IP、响应体、下载时长和解压比；拒绝 localhost、私网、link-local、云元数据地址及 `file:` / `data:`。结果中的 `contentUri` 指向 `GET /v1/documents/{id}/content?version=…`，与 `document.get` 共用服务端授权和版本校验；下载时再次校验主体和文档 ACL，不把内部路径或永久公开对象 URL 回给调用方。

## 持久化、去重与重启恢复

- SDK 1.3.0 提供 `DatabaseTaskStore` 与 `DatabasePushNotificationStore`，官方样例覆盖 PostgreSQL、MySQL、SQLite、Cloudflare D1 的任务/推送配置持久化。它保存 A2A Task 快照、历史、状态和 Artifact；它本身不承诺 Pi 任务队列执行恢复，也不提供文档写入 exactly-once。
- 为 `requestId` 持久保存 `{authenticated tenantId, principalId, operation, payloadHash, taskId, outcome/result}`，唯一键至少为 `(tenantId, principalId, operation, requestId)`。相同键且相同 payloadHash 的重放返回原 Task/结果；相同键而 payloadHash 不同，稳定返回 `IDEMPOTENCY_CONFLICT`，不得覆盖原结果。对某次业务操作的重试保持 `requestId` 不变，JSON-RPC id 可按传输请求重新生成；`messageId` 仅用作 A2A 消息身份。
- 写入 receipt、领域变更、结果发布 outbox 和 Pi Durable 映射的顺序要能在进程崩溃时恢复。建议在 PostgreSQL 事务中原子提交 receipt + 领域变更/outbox，以 `requestId` 作为下游幂等键；outbox 只发布业务结果和 projection 通知，不保存完整聊天或 SSE event log。Pi Durable 的会话/执行 checkpoint 留在其自己的持久 SQLite。由于 Pi SQLite 与业务 PostgreSQL 是两个存储，不假设跨库原子事务；启动 reconciliation 扫描 receipt/outbox、A2A 任务和 Pi 执行记录，安全地重投未完成工作或把不可恢复任务标成 FAILED，不能静默遗失、重复保存或错误标成 COMPLETED。
- 保存映射 `A2A contextId ↔ Pi conversationId`、`A2A taskId ↔ Pi submission/task id`，只向客户端暴露 A2A ID。Pi 内部数据库文件和私有 conversation 内容不作为 API。
- 官方 JS SDK 的 `DatabaseTaskStore` 默认以 tenant 与 owner 隔离；默认 owner resolver 使用认证用户名，未认证调用进入公共的 `unknown` owner scope。因此配置 opaque token 后，必须将稳定 principal 映射进 owner resolver；同时检查领域数据库的每次 ACL。不能把仅启用 SDK store 当成租户隔离完成。

## 错误合同

优先保留协议错误的标准含义；JSON-RPC 的官方 A2A 错误映射如下：

| 情况 | JSON-RPC code | 处理 |
|---|---:|---|
| JSON-RPC 格式、参数或 DataPart Schema 不合法 | `-32600` / `-32602` | `error.data` 以 `google.rpc.BadRequest` 描述字段错误。未知业务 operation 不是未知 JSON-RPC 方法，应归为应用请求校验错误。 |
| 未知 JSON-RPC method | `-32601` | 方法名无效/不支持。 |
| A2A task 不存在或调用方无权访问 | `-32001` | 不区分“从未存在”与“无权访问”，避免资源枚举。 |
| Task 不可取消 | `-32002` | 终态任务不能改写。 |
| A2A 不支持该功能 | `-32004` | 如对未声明 streaming 的服务调用 `SubscribeToTask`。 |
| 不支持 DataPart 媒体类型 | `-32005` | 返回可行动的受支持 MIME 列表。 |
| A2A 版本不支持 | `-32009` | 实现兼容日志与 `A2A-Version` 检查。 |
| 未认证/授权不足 | HTTP `401` / `403` | 在 HTTP 认证边界拒绝；带标准 challenge，避免泄露任务或文档存在性。 |

如果请求已接受并创建 A2A Task，后续解析、索引或业务处理失败，应将 Task 终态置为 `TASK_STATE_FAILED`，并通过 Artifact DataPart 返回应用 `outcome:"failed"`、稳定 `error.code`、可公开 `message` 和 `retryable`；不要伪装成 A2A `TaskNotFoundError` 或占用 A2A 已定义的 `-32001…-32009`。例如校验重用同一 requestId 但内容不同属于接受前的 `IDEMPOTENCY_CONFLICT` 参数错误；文档搜索零命中是 `TASK_STATE_COMPLETED` 加空 `results`，不是错误。瞬时模型/解析服务故障需有 retryable 信号，内部凭据、提示词和跨租户资源信息不得出现在消息中。

## 互操作门禁与验收

在声明 A2A 可供外部 Agent 使用前，至少通过以下门禁并留存原始请求/响应或 SSE 轨迹：

1. M0 先核实官方 A2A TCK 是否有适用于 v1.0.1 的发布版及其运行说明；如无可用套件，记录核查结果，不猜测命令。固定 `@a2a-js/sdk@1.3.0` 与 A2A `v1.0.1` 后，按官方 conformance 材料核对 Card、camelCase 字段、ProtoJSON 枚举、`SendMessage` / `GetTask` / `ListTasks` / `CancelTask` / streaming 的协议行为。特别验证 v1.0.1 的 TaskState 与 content type 变更；SDK README 只承诺 v1.0.0。
2. 用原始 JSON-RPC 客户端、官方 JS client，以及至少一种独立语言/框架的 v1.0 客户端，分别发现同一 Agent Card 并成功保存、检索；确认它们都发送 `A2A-Version: 1.0`，消费 DataPart 的 `data`，并识别 Task Artifact。不得只验证本项目 SDK 自己和自己互通。
3. 验证 `SendMessage` 与 `GetTask`：发送 save/search 后立即得到服务端生成 taskId；`GetTask` 在完成前为 working，在完成后有 terminal 状态和应用结果 DataPart；过程重启后仍可查询并取得相同结果。
4. 验证 `SubscribeToTask` / `SendStreamingMessage`：首事件是 Task，后续状态、Artifact 顺序正确，终态闭流；对终态订阅与对完成任务继续发送消息返回规范错误。对长索引任务验证取消能中止可取消步骤并落为 CANCELED。
5. 验证 `INPUT_REQUIRED` / `AUTH_REQUIRED` 可由相同 taskId/contextId 续传；跨 task 或不匹配 contextId 的消息被拒绝。
6. 使用两个不同 principal/tenant 做隔离测试：GetTask、ListTasks、知识库搜索、`GET /v1/documents/{id}/content` 与 task stream 均无跨主体读写；不可见资源统一按 not-found / resource-unavailable 处理。特别验证未认证请求不会进入默认共享的 `unknown` owner scope。
7. 用相同 `requestId` 和相同 payload 重放保存，不生成重复 document/version；同一 requestId 配不同 payload 明确报冲突。模拟每个持久化步骤后的进程崩溃，验证 outbox/reconciliation 无丢失或重复副作用。
8. 分别覆盖 text、uploadId、受限 URL 三类 save source；测试大文件不进入 A2A JSON，过期或他人 uploadId 被拒绝；搜索结果的 contentUri 必须通过授权下载并返回对应版本原文。

本轮尚未运行官方 TCK、SDK sample、真实 A2A 请求或真实跨客户端互操作；上述列表是实施验收门槛，不是已通过的结果。

## 未决项

- token 的本机签发、轮换、撤销和恢复流程按产品架构文档实现，不强制绑定 JWT/OIDC。
- `document.get` 的 cursor/limit、`document.update` 的 expectedVersion、delete 即时 tombstone 与最迟 24 小时物理清理 以及保存 `waitFor: "stored"` 后独立 ingestion task 的语义，按 [数据与处理流程](05-data-and-pipelines.md) 和业务请求/结果 Schema 执行；实施时不要在 A2A 层另造一套参数或状态。上传接口为 `POST /v1/uploads` multipart，内容读取接口为 `GET /v1/documents/{id}/content?version=…`，并与 domain `document.get` 共用 ACL。
- 远程部署的 TLS 终止位置、token 轮换入口和限流值，在本机 P0 验收后按部署环境确定。
- 对不兼容的 A2A v0.3 客户端是否开启 SDK `legacyCompat`。默认只提供 v1.0；只有确认真实消费者仍使用 v0.3 且建立双版本互操作测试后，才启用兼容层。不能把 v0.3 的旧 Card 路径、方法名或 `kind` Part 混进 v1.0 示例。

## 官方来源

以下版本与源码在 2026-10-16 检查：

- A2A 稳定发布：[`a2aproject/A2A v1.0.1`](https://github.com/a2aproject/A2A/releases/tag/v1.0.1)；规范文档 [`docs/specification.md`](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md)、规范 protobuf [`specification/a2a.proto`](https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto)。
- 官方 JS/TS SDK：[`a2aproject/a2a-js v1.3.0`](https://github.com/a2aproject/a2a-js/releases/tag/v1.3.0)；[`package.json`](https://github.com/a2aproject/a2a-js/blob/v1.3.0/package.json)、[`README`](https://github.com/a2aproject/a2a-js/blob/v1.3.0/README.md)、[`JSON-RPC handler`](https://github.com/a2aproject/a2a-js/blob/v1.3.0/src/server/transports/jsonrpc/jsonrpc_transport_handler.ts)、[`Persistent stores`](https://github.com/a2aproject/a2a-js/blob/v1.3.0/docs/persistent-stores.md)、[`database sample`](https://github.com/a2aproject/a2a-js/tree/v1.3.0/src/samples/agents/database-agent)。
- Agent Card well-known 路径由 v1.0.1 规范 §8.2/§14.3 与 SDK `AGENT_CARD_PATH` 明确为 `/.well-known/agent-card.json`。
