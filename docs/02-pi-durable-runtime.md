# Pi Durable 运行时核验与应用边界

日期：2026-10-16。本文是基于 npm registry 与上游 Pi `v1.3.0` 的运行时设计。后续 M0 已安装精确依赖并通过限定范围的 SQLite 恢复试验，见 [实际记录](10-m0-implementation.md)；本文的完整业务集成与故障恢复设计仍待实施验收。

## 1. 版本基线

截至检查日，`@earendil-works/pi-durable` 的 registry 最新版本是 **1.3.0**，于 2026-10-15 发布，要求 Node `>=22.19.0`。上游 tag `v1.3.0` 指向提交 `71023aec1546d6d677a65669c5665c0927ce0dd0`。其 package manifest 将 `@earendil-works/pi-ai` 和 `@earendil-works/chord` 精确固定在 **1.3.0**，并依赖 `@earendil-works/pi-codemode@1.3.0`；实施应把运行时和依赖写入 lockfile，避免使用浮动版本。[package.json](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/package.json#L142-L151) · [上游 v1.3.0 发布记录](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/CHANGELOG.md#L1-L18)

RSI 中现有安装为 `@earendil-works/pi-durable@1.1.0`，比 registry 最新版落后两个 minor 版本；它仅用来了解已有实践，不应作为本项目版本基线。1.2.0 包含多项 breaking changes，例如工具结果字段、工具任务输入形状和 Storage 错误处理，故不能把 1.1.0 的类型或示例直接当成 1.3.0 合同。[1.2.0 变更](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/CHANGELOG.md#L18-L35)

上游 README 将包标记为 **Experimental，版本间 API 可无通知变化**。P0 应锁定 1.3.0 与 Node 最低版本，并在首次实施阶段建立 Pi API 小型兼容/恢复验收；升级 Pi 作为显式维护事项处理。[README](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md#L1-L8)

## 2. Pi Durable 自带什么

| 能力 | 库提供的事实 | 本服务仍需实现 |
|---|---|---|
| Harness / Session | 一个 Harness 打开一个 Session 和 Storage；所有 Pi 记录与 Pi Documents 通过同一条原子 commit 线持久化。`Harness` 扩展 `Session`。 | 服务进程生命周期、健康检查、认证、租户、业务数据库、进程监督和备份策略。 |
| Conversation | 持久化 transcript，由不可变 entries 和会话级 Pi Documents 组成；可创建多个 conversation 或基于可见 entry fork。每个 conversation 有独立的 provider-facing UUIDv7 `sessionId`。 | 将已认证的 A2A `contextId` 绑定到主体和 Conversation；禁止跨租户共用一个全局根对话。Pi provider UUID 是模型会话亲和身份，不是用户身份。 |
| Agent 与工具 | Agent 的 model、instructions、extension 和 tools 通过 Registry 解析；`defineTool()` 使用 TypeBox 参数 schema，Harness 在调用 `execute()` 前验证参数。 | 文档工具、权限检查、业务结果 schema、请求上下文和领域服务。模型参数不能指定或提升主体。 |
| 自定义 Task | `defineTask()` 定义有版本的状态机；Registry 提供可执行定义；调度器保存 checkpoint、任务 ownership、等待关系和终态收据，可在重启后接续。 | 解析、切块、Embedding、索引写入、重试规则、业务状态、外部调用幂等、租户隔离及 A2A 状态投影。 |
| Pi Documents / DocFamily | 带版本的 JSON 文档可按 Session、Conversation 或 Task 作用域持久化；`DocFamily` 是按字符串 key 寻址的一组文档。它们能和 task/entry 在 Pi commit 中一起提交。 | 文档正文、二进制、向量、ACL、检索索引和大体量解析结果。Pi Document 只保存小型运行状态和稳定引用。 |
| SQLite Storage | Node adapter 使用单个 SQLite 文件、WAL 和 `synchronous=NORMAL`；进程崩溃后的提交可恢复。Pi Storage 同一时间只允许一个进程拥有，没有跨进程锁。 | 单进程 owner、持久卷、备份、启动 reconcile 与多副本 fencing。PostgreSQL 业务库不能借 Pi SQLite 自动获得同一事务。 |
| 观察与事件 | Conversation `watch()` 在挂接时返回当前 view，之后串行交付 commit delta；积压超过 100 帧会合并成最新 view。迟到或重连的观察者只拿当前 view，没有历史 replay。 | A2A Task 快照、Artifact 持久化及标准 `GetTask` / `SubscribeToTask`。Pi watch 不能直接等同于 A2A Task stream，也不要求本项目 P0 实现 `Last-Event-ID` 或逐事件历史重放。 |

上述对象关系和原子性规则见 [README Concepts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md#L80-L101)；Task、Document 和事务类型见 [源码类型定义](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts#L68-L88)、[Task 定义](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts#L141-L155)、[TaskRuntime](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts#L166-L240)、[Harness API](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/types.ts#L699-L742)。

### Harness / Session / Conversation

`Harness.open(storage, options, context)` 打开一份 Pi Storage；`root()` 取得保留的根 Conversation，`createConversation()` 建立其他隔离会话，`resume()` 启动或恢复任务调度。Conversation handle 本身不持有会话状态，身份以 `conversation.id` 为准。README 给出的 SQLite 重开和恢复入口是 `openNodeSqliteStorage()`、`Harness.open()`、`root()`、`resume()`。[Persist and Resume](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md#L103-L126) · [Conversation / Harness 接口](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/types.ts#L640-L741)

A2A 调用若需要继续同一上下文，应由应用表维护 `(tenantId, principalId, a2aContextId) → conversationId`；Pi 不做授权或主体绑定。Conversation 自带 provider UUIDv7 是 Pi 发送给 pi-ai 的 session identity，不能拿它充当 principal、租户 ID 或 A2A context ID。[Provider session identity](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md#L113-L115)

### Task / Tx / DocFamily 的真实边界

自定义 Task 是真实的、可恢复的执行单元，不是把普通 HTTP handler 包一层 Pi 名称。其定义有持久化 `name` 与 `version`、`initial(input)`、按 checkpoint phase 分派的 `phases`、必需的 `abort`，以及可选的旧版本 `migrate()`。每个阶段应通过 `runtime.commit()` 写入下一 checkpoint 或终态；处理函数无持久进展就返回会使 task `faulted`。调度器在打开 Session 时将上次遗留的 `running` 任务改回 `pending`；运行时如未注册相应 task 定义，会把任务报告为 blocked，而不是猜测如何执行。[TaskDefinition / TaskRuntime](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts#L141-L155) · [任务状态与版本](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts#L242-L266) · [打开时恢复 running task](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/scheduler.ts#L288-L315) · [缺少定义的检查状态](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/types.ts#L597-L617)

`Tx` 是 **Pi Session 内部**事务：可创建 conversation/task、append entry、settle submission、访问 Pi Documents 和 families。一个 `tx.createTask()` 与 `tx.doc()` 可在同一个 Pi commit 中原子写入；它不能把 PostgreSQL 行、blob 对象存储或第三方 HTTP 调用纳入 Pi SQLite 事务。规范明确规定外部副作用不能在 Session mutation transaction 内执行。[Tx API](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts#L786-L875) · [Durability invariants](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/docs/spec.md#L41-L78)

`defineDocFamily()` 的 `initial(seed)` 只在该 key 首次出现时初始化。当前 API 支持 session、conversation 或 task 作用域，所有值为严格 JSON，定义含稳定 `kind` 和整数 schema `version`。[defineDocFamily 实现](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/documents.ts#L33-L80) · [DocFamily 类型](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts#L68-L102)

下面只表示基于已核实签名的调用形状；代码、定义名和策略均是设计样例，尚未在新项目编译或验证：

```ts
type A2ATaskBindingValue = {
  taskId: string;
  payloadHash: string;
  piTaskId: number | null;
};

const A2ATaskBinding = defineDocFamily<A2ATaskBindingValue, { taskId: string; payloadHash: string }>({
  kind: "app.a2a-task-binding",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({
    taskId: seed.taskId,
    payloadHash: seed.payloadHash,
    piTaskId: null,
  }),
});

// 在 PG outbox dispatcher 中调用；key 由服务端构造并带 tenant 命名空间。
const piTaskId = await harness.commit(async (tx) => {
  const binding = await tx.doc(A2ATaskBinding, `${tenantId}:${a2aTaskId}`, {
    taskId: a2aTaskId,
    payloadHash,
  });
  if (binding.payloadHash !== payloadHash) throw new Error("IDEMPOTENCY_CONFLICT");
  if (binding.piTaskId !== null) return binding.piTaskId as TaskId;

  const id = await tx.createTask(DocumentIngestTask, taskInput, {
    ownership: { kind: "conversation" },
    conversationId: serviceConversationId,
    background: true,
  });
  binding.piTaskId = id;
  return id;
}, BACKGROUND_CONTEXT);
```

`TaskOptions` 要求 task 有 conversation owner 或父 task；`tx.createTask()` 支持显式 `conversationId`。因此不能假设 Pi 有脱离 conversation 的任意 A2A job queue。结构化资料任务可绑定到服务端为该主体/租户选择的 Conversation，并标记 `background` 以免普通会话 idle/abort 规则误伤；A2A 显式取消再映射到 `harness.abortTask(piTaskId, context)`。`background` 不是免取消或永久运行标志。[Task ownership 和 background](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts#L273-L299) · [createTask 真实签名](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts#L812-L869) · [abortTask / waitForTask](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/types.ts#L716-L741)

**建议的注册和阶段形状**：

```ts
const DocumentIngestTask = defineTask({
  name: "app.document-ingest",
  version: 1,
  initial: (input: IngestInput) => ({ phase: "verify", generationId: input.generationId }),
  phases: {
    verify: async (task, runtime, context) => {
      // domain 函数先用 PG receipt / 稳定 generationId 实现幂等；此处是外部工作。
      const result = await documentService.verifyBlob(task.input, runtime.signal);
      await runtime.commit((_tx, current) => ({
        status: "running",
        checkpoint: { ...current.state.checkpoint, phase: "parse", verified: result.ref },
      }), context);
    },
    // parse → chunk → embed → stage-index → publish；每步写 receipt 后再推进 checkpoint。
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({
      status: "terminal",
      outcome: { status: "aborted", reason: "a2a_cancelled" },
    }), context);
  },
});

const DocumentAgent = defineExtension({ name: "document-runtime", tasks: [DocumentIngestTask] });
registry.install(DocumentAgent);
```

样例刻意把数据库与模型调用留在应用服务：Task handler 在事务外执行阶段工作，再通过 `runtime.commit()` 原子更新 **Pi** checkpoint。实际 `PhaseHandler` 和 commit 类型见 [类型定义](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts#L141-L202)；Extension 可携带 tasks，Registry 从已安装 Extension 收集并按 task name 查找定义，重启部署必须注册相同 name 并提供兼容版本或 migrate。[Extension 类型](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/types.ts#L361-L373) · [Registry task 收集](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/registry.ts#L12-L30) · [defineTask](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/tasks.ts#L1-L8)

### defineTool：只给自然语言路径调用

`defineTool()` 根据 TypeBox `parameters` 推导并校验输入。搜索、读取和受权保存工具复用同一 `documentService`，但在自然语言路径由 Pi Generation 调用。结构化 A2A 操作不必先经过模型，也不应该用临时 HTTP handler 代替持久化 Task。工具可声明 `structuredOutputSchema` 供程序读取结构化结果。[defineTool 签名](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/define.ts#L12-L17) · [工具校验与 structuredOutput](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md#L164-L199)

工具有 `replay: "safe" | "unsafe"` 策略，默认 `unsafe`。安全工具在“intent 已提交、execute 尚未完成”时进程崩溃会重新执行；它不会替第三方调用提供 exactly-once。Pi 对生成请求另有 `settings.retry` / `maxRetries`，只用于模型请求的可重试错误；这不是自定义 Task 的通用网络重试策略，也不能覆盖 parser 或 embedding 服务的副作用。[工具 replay 策略](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/types.ts#L289-L305) · [Task 工具恢复逻辑](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/tool.ts#L113-L204) · [模型重试策略](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/generation.ts#L487-L531)

## 3. 保存、解析和索引的崩溃一致性

Pi 的 Task checkpoint 与 PostgreSQL/对象存储不能形成一个分布式事务。正确承诺应是“重放可恢复、最终业务结果有效一次”，不要承诺外部 HTTP/Embedding 请求 exactly-once。

**admission 与任务映射**：

1. A2A 请求验证认证主体、scope、知识库 ACL、业务 schema 和大小；PG 事务按 `(tenantId, principalId, operation, requestId)` 写 `requests`、外部 `a2a_tasks` 投影和 outbox event。相同 requestId + payloadHash 返回原 task；相同 requestId + 不同 hash 返回冲突。
2. dispatcher 读取 outbox，按稳定的 `(tenantId, a2aTaskId)` Pi DocFamily key 调用 `Harness.commit(tx => tx.doc(...) + tx.createTask(...))`。这使“Pi task 创建”和“Pi 内部映射”在 Pi 自己的存储中原子提交。dispatcher 成功后标记 PG outbox；若在 Pi commit 后、PG ACK 前崩溃，重投会读到同一个 Pi Task ID。
3. 若在 PG outbox commit 前崩溃，没有对外已接受的 task；若 PG 已提交但 Pi 未提交，outbox 重投继续创建。Pi 端的绑定文档是恢复幂等凭证，不是 PG 业务数据库的替代品。

Pi input `Submission` 的 `requestId` 仅在 **一个 Conversation 范围**去重，不校验业务 payload hash；它适用于自然语言输入重试，不能代替跨租户 A2A request receipt。自定义 `tx.createTask()` 本身也没有 requestId 字段。因此结构化任务使用 PG outbox + Pi DocFamily 映射。[Submission requestId 范围](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/types.ts#L370-L379) · [Conversation.submit 重试示例](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md#L117-L126)

**文档 ingest phases**：

```text
received / stored
  → verify-blob
  → parse
  → chunk
  → embed (bounded batch)
  → stage-index
  → publish (one PG transaction + revision CAS)
  → completed / failed / canceled
```

- Pi Task `input` 和 checkpoint 只保存 `tenantId/kbId/documentId/version/generationId`、当前 phase、批次游标和必要哈希/引用。源文件放 blob，版本/解析摘要/chunks/向量/索引代次放 PG。不要将全文、Embedding 数组或授权令牌塞进 Pi `DocFamily`。
- PG `processing_receipts` 以 `(generationId, stage, inputHash)` 建唯一键，记录 attempt、状态和输出引用。parser 输出、chunks 和 embeddings 以 generation 作为不可变命名空间，使用可重复 upsert。外部调用使用稳定幂等键（若供应商支持）和显式超时、分类重试上限、退避和任务预算。
- 每个批次按顺序完成：读取/验证 PG receipt → 外部执行或复用 receipt → 持久化 PG 结果 → Pi `runtime.commit()` 推进 checkpoint。若外部服务成功后进程在 PG receipt 前崩溃，调用仍可能重复；对不支持幂等键的付费 API 记录该风险并限制预算。Pi checkpoint 不能证明外部响应已持久化。
- 先把整个 generation 写入不可见的 staging rows，并核对 chunk 数、Embedding profile/维度和输入哈希。**发布**仅在 PostgreSQL 单事务内将 generation 标 `ready`、CAS 切换 `documents.activeGeneration/activeVersion`，并追加发布事件。检索 SQL 只读当前 active 且 ready 的 generation；故中途重启不会让半个索引可见。
- Pi 完成与 PG 发布投影存在 ACK 窗口。task 进入 terminal 前确认 PG 发布 receipt；应用启动/定期 reconciliation 对账“Pi terminal vs PG projection”以及待处理 outbox。A2A `completed` 只从业务投影确认，不从模型回答文本推断。
- cancellation 通过 PG revision/fence 和发布事务序列化：取消先提交则 publish CAS 失败；发布先提交则明确返回已完成。A2A 显式取消调用 `Harness.abortTask()`；HTTP/SSE disconnect 只取消 wait/stream，不自动取消后台任务。Pi 的 `Context` 取消也只取消 wait，持久 task 取消需要 abort mark 和任务 `abort()` 清理流程。[Context cancellation](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md#L71-L78) · [Task abort API](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/types.ts#L716-L741)

## 4. 身份和业务 ID 的映射

| 概念 | 权威存储和映射 | Pi Durable 是否直接定义它 |
|---|---|---|
| `principalId / tenantId` | 由认证层从服务端凭据解析，PG 权限表与审计记录。 | 否；Conversation 与 Pi Task 不提供授权。 |
| A2A `contextId` | PG 将已验证主体绑定到 Pi `conversationId`；无 context 的请求按策略新建会话。 | Pi 提供 Conversation 与稳定本地 ID；不认识 A2A context 语义。 |
| A2A `taskId` | PG 是公开任务状态与稳定 ID 的权威；PI SQLite 内 Session DocFamily 键映射 `tenantId:a2aTaskId → piTaskId`。 | 否；Pi Task ID 是内部数值 ID，不等于协议 taskId。 |
| `attemptId`（可选） | 若排障需要，可作为 `a2a_tasks` 或 processing receipt 上的诊断字段，标识一次 provider/阶段尝试；无需新建 run 表或对外资源。 | Pi 的“run”描述一个 input 到最终回答的 turns，但它不是 A2A 公共 ID。自然语言幂等关联使用 `requestId → submissionId`。 |
| `documentId / documentVersion / generationId` | PG 文档领域模型；版本不可变，generation 标识 parser/chunker/embedding 配置的一次构建。 | 否；Pi Document 是 JSON runtime state，不是知识库文档版本。 |
| Pi `conversationId / taskId / submissionId` | 只用于恢复 Pi 内部执行和按内部 API 观测。 | 是；不要透传到 A2A wire response 作为公共资源 ID。 |

建议的公共资源联结：

```text
A2A contextId ── principal-bound row ── Pi conversationId
A2A taskId ───── requests/a2a_tasks/outbox ── Pi DocFamily binding ── Pi taskId
A2A requestId ── PG payloadHash receipt ── (natural language only) Pi requestId/submissionId
(documentId, version, generationId) ───────── PG domain rows / blob references
```

用户/租户授权、业务幂等、A2A 任务生命周期和最终索引状态在 PG；Pi SQLite 负责可恢复执行和 conversation transcript。两套状态每个关联都保存稳定 ID，不以同序号、模型 session UUID 或“当前 Pi root”隐式关联。

## 5. A2A Task stream 与 Pi watch

Pi `Conversation.watch()` 在订阅开始时提供当前 view，之后发已提交的 Chord operations；当慢观察者积压超过 100 帧时，把积压压成代表最新全量状态的一帧。重连重新挂接会获得现在的 view，**不会返回错过的事件**。[Watching a Conversation](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md#L378-L406)

P0 遵循 A2A 标准 Task 语义：PG 的 A2A TaskStore 持久化可查询的 Task 快照、状态和 Artifact；`GetTask` 在任何重连或进程恢复后返回最新快照，`SubscribeToTask` 对仍工作的 task 按协议发送 Task 快照和连接期间的更新。客户端断线不取消处理任务，重新连接后通过标准查询/订阅取得当前状态；不承诺每个内部 Pi commit、token delta 或断线期间的完整事件历史，也不增加自定义 `Last-Event-ID`、reset frame 或 SSE wire event。协议更新必须符合 A2A SDK/规范的 Task 与 Artifact 形状。[A2A Task 方法与 stream contract](04-a2a-contract.md)

Pi watch 可用于驱动本进程中的视图投影，但不是 A2A TaskStore、跨进程事件日志或可重放的 A2A SSE source。只有 P1 明确需要断线期间逐更新补发时，才设计额外的持久事件/游标扩展，并先确定它如何与标准 A2A task subscription 兼容；这不是 P0 验收条件。

## 6. SQLite 耐久度、恢复与运行约束

Pi README 对 Node SQLite 的现状说明为 WAL + `synchronous=NORMAL`：进程崩溃可恢复，但突然掉电或主机故障可能丢失最新 commit；并要求一个进程拥有该 storage，不提供跨进程锁。[SQLite Storage](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md#L656-L684) 上游 Node adapter 的 `openNodeSqliteStorage()` options 没有同步模式字段，并在打开时固定设置 `PRAGMA synchronous=NORMAL`。[Node adapter](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/storage/sqlite/node.ts#L183-L215)

源码提供一个可组合的 FULL 配置入口，但不是 `openNodeSqliteStorage` 的选项：先打开底层 `NodeSqliteDatabase`，执行 `PRAGMA synchronous=FULL`，再把同一 database 交给 `SqliteStorage.open()`。[底层 opener](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/storage/sqlite/node.ts#L183-L215) · [SqliteStorage.open](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/storage/sqlite/storage.ts#L151-L180) · [公开导出](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/storage/sqlite/index.ts#L1-L8)

```ts
const database = await openNodeSqliteDatabase(piFile);
await database.exec("PRAGMA synchronous=FULL");
const storage = await SqliteStorage.open(database, { prefix: "pi_" });
const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
```

这是由已核实源码导出和 SQLite facade 得出的实现路径，**不是本项目已运行验证或供电故障测试结论**。上游 README 未将 FULL 描述为当前默认行为。P0 仍以进程崩溃恢复、PG/blob/Pi 协调备份及实际恢复演练为验收范围；不承诺断电零丢失。若后续要求更强掉电耐久度，先实现并核验 FULL adapter，再定义可验证的故障注入和硬件保证边界。不要在 Harness 打开后另起 SQLite connection 修改同一文件的 PRAGMA。

启动顺序：取得单进程 Pi Storage owner → `Harness.open` 并安装所有 Task/Extension definitions → 恢复 scheduler → PG/outbox/task reconcile → 验证关键依赖 → ready 接单。Pi Storage 读写错误在 1.2 起会使 Session fail/close，Harness 不会自动重试该 Session；收到 `SessionFailed` 后停止接单、关闭观察流，重开 storage 并 reconcile。[1.2 Storage failure semantics](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/CHANGELOG.md#L18-L27)

## 7. 实施前的 Pi Durable 验收门槛

1. **锁定与类型门槛**：Node 22.19+；锁住 `pi-durable/pi-ai/chord@1.3.0` 及完整 lockfile；真实注册 `defineTask`、`defineExtension(tasks)`、`defineDocFamily`；session transaction 中重复执行同一外部 task admission 时只保留一个 Pi task mapping。
2. **恢复门槛**：在 Pi Task 的每个 checkpoint 前后以及 `running` 阶段强制终止进程；重开同一 SQLite、重新装载定义并 `resume()`，只从最近已提交 checkpoint 恢复。缺失或不兼容的定义应明确阻止接单，不得丢弃任务记录。
3. **双存储门槛**：分别在 PG outbox 已提交/尚未投递、Pi task 已提交/PG ACK 未提交、外部调用成功/PG receipt 未提交、generation staging 完成/发布 CAS 前后终止并恢复。确认 receipt 可重用、公共 taskId 稳定、重投不创建第二次有效发布，并将不可避免的重复外部调用计入证据。
4. **发布门槛**：故意在不同 chunk batch 后终止进程，验证活动查询始终看不到 staging generation；发布事务提交后可见完整索引；版本 CAS 冲突不覆盖较新版本。
5. **取消门槛**：覆盖排队、解析、Embedding 等待/返回与 publish race；断开 A2A SSE 时后台任务仍可恢复；仅明确合法的 A2A cancel 才落 PG 取消意图并映射到 Pi `abortTask()`。
6. **A2A Task 门槛**：覆盖标准 `GetTask` 在 Pi/服务重启后的最新快照和 Artifact；对仍工作的 task 验证 `SubscribeToTask` 先给 Task、连接期间给状态/Artifact 更新并在终态结束。断线后按 A2A 标准查询/重新订阅，不承诺补发断线期间的每次 Pi commit；Pi watch 积压应收敛到最新 view，不得冒充 A2A 历史。
7. **SQLite 门槛**：验证同进程 `SIGKILL` 后 SQLite/PG/blob reconcile；完成协调备份与恢复演练。检查 SQLite `FULL` 可选 adapter 的最终 pragma 和落盘行为，但不把源代码能配置等同于掉电已验证。

以上门槛均为计划，当前没有构建服务、拉取或安装 Pi Durable、改 Pi/WeKnora 配置、执行故障注入或通过运行验收。
