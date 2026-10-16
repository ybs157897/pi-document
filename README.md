# Pi Document Agent

基于 Pi Durable 的独立文档 Agent，通过 A2A 提供知识库、保存、解析、混合检索、原文引用、版本更新与删除。实施参考 [Tencent/WeKnora](https://github.com/Tencent/WeKnora/tree/2fbfb4471581cd5e7d731bc7a2d443fe7d8e95b5)，运行时不依赖 WeKnora 服务。逐项结果见 [实施与验收报告](docs/11-implementation-acceptance.md)。

当前 P0 服务核心 AC-01 至 AC-26 和独立 P1 AC-29 管理 UI 均通过本地验收；AC-29 不改变 P0 范围。OCR、问答、同步、Wiki、知识图谱和多节点部署仍在路线图中。实现交付分支为 `codex/document-agent-runtime`，尚未公开部署；不宣称 WeKnora 全功能或同等检索质量。

## 本机启动

使用 Node **24.15.0**、npm **11.12.1**。macOS 本地构建需要 Git、C 编译器、Make。PDF/DOCX/HTML 解析子进程依赖系统 `sandbox-exec` 禁止网络；未支持的平台明确拒绝这三种格式。

```sh
npm ci
npm run setup:postgres
cp .env.example .env
# 编辑 .env，填入模型凭据；已有 .env 时保留它。
chmod 600 .env
npm run dev
```

`setup:postgres` 将固定版本 PostgreSQL 17.10、pgvector 0.8.2 构建到项目 `.cache/`，不更改系统数据库。`dev` 启动专用 loopback 数据库与 `http://127.0.0.1:4328` 服务，API token 在 `data/dev/api-token`。同源管理界面位于 `http://127.0.0.1:4328/ui/`；`dev` 和 `start` 会先构建静态界面，缺少构建产物时可运行 `npm run build:ui`。登录令牌保存在当前标签页的 sessionStorage。Ctrl+C 关闭本次服务和该数据库。业务数据在 `data/service/`，开发数据库在 `data/dev/postgres-native/`，重启保留。不要同时启动两个 owner。

默认生成模型模板为 `qwen3.8-flash`，检索独立使用 `qwen3.7-text-embedding-flash`、1024 维、L2 归一化。WeKnora 同样调用独立 Embedding 模型，权重不内置于本服务。凭据仅来自环境变量；更换向量 profile 需要重建索引。没有生成模型配置时仍可调用结构化 API；没有 Embedding 配置时提供文本持久化，Card 不宣称 indexed/hybrid 能力。Rerank 未配置时明确报告降级原因。

已有专用 PG/pgvector 数据库时，设置 `DATABASE_URL`、`PI_STORAGE_PATH`、`BLOB_ROOT`、`AUTH_BOOTSTRAP_TOKEN` 后使用 `npm start`。bootstrap 只创建不存在的主体，重启不会重置已轮换或已撤销的 token。服务仅绑定 loopback；公网 TLS/SSO 属于部署阶段。

## Agent 接入

发现地址为 `GET /.well-known/agent-card.json`；JSON-RPC 地址为 `POST /a2a`，请求头 `A2A-Version: 1.0`、`Authorization: Bearer …`。JS SDK 固定为 `@a2a-js/sdk@1.3.0`。字段和错误语义见 [A2A 合同](docs/04-a2a-contract.md)。

- DataPart：`knowledge_base.create/list`、`document.save/get/list/search/update/delete`；`document.answer` 尚未实现。
- TextPart：配置生成模型后，由真实 Pi Agent 选择授权范围内的文档工具；支持 INPUT_REQUIRED 在同 task/context 续传。
- `waitFor: stored` 返回持久化收据与 ingestionTaskId；只有 `indexed` 成功才保证可检索。
- 文件通过 `POST /v1/uploads?knowledgeBaseId=…` 的 multipart `file` 字段上传，再以 `source: {kind: "upload", uploadId}` 保存。支持 TXT、MD、文本 PDF、DOCX、HTML，单文件上限 50 MiB。
- `source: {kind: "url", url: "https://…"}` 仅抓取公开 HTML，各次重定向与实际连接均受 SSRF 限制。
- 引用下载需要当前主体 token；撤权、tombstone 后旧 task/artifact 和引用也重新鉴权。

[客户端示例](examples/clients/README.md) 包含 Node 原生 HTTP、Python 标准库、multipart 和自然语言入口。开发环境调用：

```sh
export PI_DOCUMENT_AGENT_URL=http://127.0.0.1:4328
export PI_DOCUMENT_AGENT_TOKEN="$(cat data/dev/api-token)"
node examples/clients/natural-text.mjs '请列出我有权访问的知识库'
```

创建只读主体和授权：

```sh
npm run admin -- principal:create --principal reader --scopes knowledge:read --token-output data/dev/reader-token
npm run admin -- kb:grant --principal reader --knowledge-base <kb-id> --scopes knowledge:read
npm run admin -- kb:revoke --principal reader --knowledge-base <kb-id>
```

再次执行 `principal:create` 并指定新的 token 文件可轮换；`principal:revoke` 撤销主体。token 不打印到日志。`/metrics` 仅对当前租户已认证的管理员开放。

## 验证与运维

```sh
npm test                         # 本地确定性产品检查，不加载真实凭据
npm run test:faults               # 10 个窗口，每窗 3 次 SIGKILL/reopen
npm run verify:install            # 干净目录安装与实际 Pi SQLite 打开/关闭
npm run eval:retrieval            # 仅校验冻结语料，不调用模型
npm run eval:retrieval -- --live   # 真实 Embedding 检索评估
RUN_NATURAL_AGENT=1 npm run test:e2e:live
RUN_CALLER_AGENT=1 npm run test:e2e:live
npm run benchmark                # 10,000 chunks / 5 客户端 / 10 分钟
npm run benchmark:indexing       # 500 KiB MD / 10 页 PDF 尺寸回归
```

产品数据库测试需要先完成 `setup:postgres`，各自使用临时库和随机 loopback 端口。真实模型命令加载 `.env` 并产生费用。证据在 `evidence/`，失败记录也保留，最终状态以 [验收清单](evidence/final/acceptance.json) 为准。

备份、恢复与对账使用 `npm run backup`、`npm run restore`、`npm run reconcile`，详见 [运维手册](docs/operations.md)。备份必须先停止全部业务写入，包含 PG、Pi SQLite 和 blob；未验证主机掉电零丢失。

## 设计与来源

[能力映射](docs/01-weknora-capability-map.md) · [Pi 运行时](docs/02-pi-durable-runtime.md) · [架构](docs/03-product-architecture.md) · [数据流程](docs/05-data-and-pipelines.md) · [计划](docs/06-implementation-plan.md) · [验收标准](docs/07-acceptance.md) · [管理 UI 使用与边界](docs/12-management-ui.md) · [交接](docs/08-implementation-handoff.md) · [M0 记录](docs/10-m0-implementation.md)

依赖、基准 SHA 和环境保存在 [manifest](evidence/m0/manifest.json)。WeKnora 克隆在相邻独立目录并固定 SHA；未复制其业务源码或私有配置。请求/结果 JSON Schema 在 `contracts/`，`npm run generate:contracts` 生成 TypeScript 类型。
