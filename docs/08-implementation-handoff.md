# 后续实施交接

## 当前位置

工作目录为本仓库的 clone 根目录，README 示例使用 `~/work/pi-document-agent`。M0基线与M1–M4业务代码、P0 AC-01至AC-26本地验收已完成；独立P1 AC-29同源管理 UI 也已通过。最终质量、性能、真实自然语言和UI证据见 [交付报告](11-implementation-acceptance.md)、[管理 UI 使用与边界](12-management-ui.md) 与 [验收状态](../evidence/final/acceptance.json)。AC-29不并入P0，其余P1/P2仍按路线图。GitHub 仓库为 `https://github.com/ybs157897/pi-document`。

WeKnora参考目录已更新到 `2fbfb4471581cd5e7d731bc7a2d443fe7d8e95b5`，原工作树干净。后续参考应使用文档里的固定SHA链接，避免上游继续变化影响验收口径。

## 当前代码结构

当前实现已落在以下目录：

```text
src/
  app.ts                    # PostgreSQL、Pi、pipeline、A2A gateway 装配
  a2a/gateway.ts             # Agent Card、JSON-RPC/SSE、HTTP上传与自然语言入口
  config/                    # 服务、模型与文档索引pipeline配置
  domain/                    # 请求校验、业务接口与生成的合同类型
  ingestion/                 # TXT/MD/PDF/DOCX/HTML、URL来源、切块和parser worker
  retrieval/                 # embedding、中文词法分词与结果融合
  runtime/                   # Pi Durable运行时、自然语言任务与SQLite owner锁
  storage/                   # PostgreSQL迁移、文档backend与task分页
  management/                # tenant-scoped 同源管理 API
  ui/                        # /ui/ 静态资源服务
  observability/              # 故障注入钩子、日志和metrics
migrations/                  # 001–009 PostgreSQL迁移
scripts/                     # 本机开发、模型/解析/检索评估、备份恢复与管理命令
tests/                       # A2A、合同、解析、检索、运行时、存储、自然语言、安全、故障与运维
fixtures/                    # 解析与固定评估样本
examples/clients/             # Python、原始HTTP、multipart与自然语言客户端
evidence/                    # 脱敏的基线、阶段与验收运行结果
```

代码当前不含 `deploy/` 编排目录；本机开发数据库由 `setup:postgres`/`dev` 脚本启动。不要把下面的阶段状态改写成 P0 已全部通过。

## 本机启动与配置

Node 与 npm 版本分别锁为 `24.15.0` 和 `11.12.1`。要启动带向量索引的本机开发服务：

```sh
npm ci
[ -f .env ] || cp .env.example .env
# 在 .env 中配置 PI_DOCUMENT_AGENT_API_KEY 和 PI_DOCUMENT_EMBEDDING_API_KEY
npm run setup:postgres
npm run dev
```

`setup:postgres` 在 `.cache/` 下按固定源码版本构建 PostgreSQL 17.10 与 pgvector 0.8.2。`dev` 检测到这套本机数据库后使用它；配置了 `EMBEDDING_MODEL_ID` 却没有构建好的本机数据库时会拒绝启动。未启用 embedding pipeline 时，`dev` 可使用其持久化 embedded PostgreSQL 后备路径。开发数据、数据库密码与自动生成的API token保存在 `data/dev/`；自动生成的 token 文件路径会在 ready 事件中显示为 `data/dev/api-token`。应用和开发数据库仅绑定 loopback，应用默认地址为 `http://127.0.0.1:4328`，`HOST` 只接受 `127.0.0.1`、`::1` 或 `localhost`。

复制 `.env.example` 后必须为已启用的模型配置凭据：Pi自然语言模型读取 profile 指定的 `PI_DOCUMENT_AGENT_API_KEY`；索引pipeline读取 `PI_DOCUMENT_EMBEDDING_API_KEY`。若只验证 `waitFor: "stored"` 的文本保存流程，可从 `.env` 中移除 `AGENT_MODEL_PROFILE` 与 `EMBEDDING_MODEL_ID`（以及对应embedding设置），从而关闭模型调用与索引。

`npm start` 是服务进程入口，不会启动 PostgreSQL；它要求显式设置专用 `DATABASE_URL`，默认使用 `data/service/pi.sqlite` 和 `data/service/blobs`。本项目当前仍强制 loopback 监听，不能把 `HOST` 改成公网地址。

## 同源管理 UI

本机开发默认从 `http://127.0.0.1:4328/ui/` 打开；服务同源提供 UI、A2A 与 `/api/manage/*`，不开放跨域 CORS。`npm run dev` 和 `npm start` 的 pre-script 会运行 `npm run build:ui`，产物位于 `dist/ui/`；无构建产物时 `/ui/` 返回提示页，并可单独运行 `npm run build:ui`。

登录时输入该服务签发的 Bearer token；前端仅将其保存在当前标签页的 `sessionStorage`，退出或关闭标签页后不保留。`GET /api/manage/me` 返回身份与 `indexing`、`natural`、`uploads` 能力。管理员可管理当前tenant的主体令牌和KB成员；普通主体只读取自己有效的KB权限。权限响应为全局scope与KB grant的交集，后端每次操作仍独立执行ACL校验。完整路由、有效scope、幂等重试与浏览器验收限制见 [docs/12](12-management-ui.md)。

| 配置 | 当前实际行为 |
|---|---|
| `HOST` / `PORT` | 默认 `127.0.0.1:4328`；只接受 loopback 主机名或地址 |
| `DATABASE_URL` | `npm start` 必填；`npm run dev` 自动提供隔离的本机数据库 |
| `PI_STORAGE_PATH` | 默认 `data/service/pi.sqlite`；Pi Durable SQLite存储由独立owner锁保护 |
| `BLOB_ROOT` | 默认 `data/service/blobs` |
| `PUBLIC_BASE_URL` | 可选；用于Agent Card和引用链接，必须为无凭据的HTTP(S) URL |
| `AGENT_MODEL_PROFILE` | 可选；指向 `config/model.example.json` 形式的受信任profile，profile读取API key环境变量；仅配置时启用自然语言Agent |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL_ID` / `EMBEDDING_DIMENSIONS` | 同时配置embedding API key环境变量时启用索引pipeline；当前开发profile为Qwen 1024维 |
| `AUTH_BOOTSTRAP_TOKEN` | 首次启动时创建默认 `local/local-agent` 管理主体；服务启动使用 `ON CONFLICT DO NOTHING`，不会覆盖已有或已轮换的token |
| `AUTH_TENANT_ID` / `AUTH_PRINCIPAL_ID` | 可选，修改bootstrap主体的tenant和principal ID，默认 `local` / `local-agent` |
| `LOG_LEVEL` | 设为 `silent` 关闭HTTP响应事件日志；默认记录结构化请求结果 |

本机开发未设置 `AUTH_BOOTSTRAP_TOKEN` 时，`dev` 会在 `data/dev/api-token` 创建随机token；用 `.env` 中的token值则复用该值。token只存摘要到PostgreSQL。首次 bootstrap 创建管理员后，可创建token目录并用 admin CLI 轮换同一主体：

```sh
mkdir -p data/admin
npm run admin -- principal:create --principal local-agent --scopes knowledge:read,knowledge:write,knowledge:delete,knowledge:admin --token-output data/admin/local-agent-rotation-1.token
```

`principal:create` 会更新该主体token和scope；token输出文件必须是新路径，并按0600权限创建。`principal:revoke` 可撤销主体，bootstrap不会把它自动恢复。

## 已决技术基线与边界

| 范围 | 当前决定和验证边界 |
|---|---|
| 自然语言模型 | 用户指定的 `qwen-maas/qwen3.8-flash`，base URL 为 `https://maas.qianwenaiapi.com/compatible-mode/v1`；M0真实请求/工具调用通过。供应商价格未核实，M4真实调用已验证 |
| Embedding | `qwen3.7-text-embedding-flash`，1024维、L2归一化；M0验证了真实接口和向量形状，最终合成检索质量与固定负载性能已验证。未配置Reranker，搜索结果会报告相应降级原因 |
| PDF | `pdfjs-dist@6.4.299`，提取带页码和页内Unicode code-point偏移的文本；扫描PDF/OCR不在当前范围 |
| DOCX | ZIP中央目录检查、限输出的 `node:zlib.inflateRawSync` 和 `cheerio@1.2.0` XML模式，按原始 `w:p` 顺序保留段落定位；不是完整ZIP安全审计或版式还原 |
| HTML | `cheerio@1.2.0` 解析捕获的HTML字节并保留heading path/fragment；URL来源抓取单独经过受限fetch流程 |
| TXT/MD | Node UTF-8解析；Markdown提供标题层级与行范围，不覆盖所有Markdown扩展 |
| Parser worker | PDF/DOCX/HTML使用独立worker，配置50 MiB输入、200 MiB展开上限、500 PDF页、512 MiB old-space、1 GiB RSS与120秒超时。在macOS用 `/usr/bin/sandbox-exec` 对worker禁止网络；未验证其他平台的等价进程沙箱时fail closed。该profile只隔离网络，不限制文件系统 |
| 中文词法 | Node `Intl.Segmenter('zh', { granularity: 'word' })` 加 PostgreSQL `simple` text search；Node锁为24.15.0，M0运行时ICU为78.2。固定探针40/40精确词/编号命中；6条同义探针无词面命中，不能据此宣称语义检索质量 |

## 未决事项与默认推进方式

| 事项 | 当前默认 | 何时必须决策 |
|---|---|---|
| 是否要求全部UI一比一 | AC-29管理 UI 已通过；完整产品 UI 超出本次范围，仍属P1/P2差异 | 扩展UI范围前与用户明确视觉/交互门槛 |
| 模型预算 | Qwen模型与profile已锁；成本未知 | 预算/生产成本策略确定前，保持报告标记 `pricing_not_verified` |
| Parser扩展 | 当前PDF/DOCX/HTML实现与版本已锁；扫描PDF/OCR/复杂布局未支持 | 开始P1格式/OCR工作前单独定义格式和保真门槛 |
| A2A互操作范围 | 使用 `@a2a-js/sdk@1.3.0`，验证过v1.0 JSON-RPC表面；不等于完整v1.0.1/TCK合规 | 目标Agent或协议范围改变时，重新跑独立互操作门槛 |
| 中文词典/语义补足 | 当前采用Node/ICU `Intl.Segmenter` 与PG simple全文，无自定义同义词典 | 如P1需要同义词能力，在冻结的独立检索集上设计并验证 |
| 服务公网部署/SSO | 本机服务token，公网TLS在部署时设置 | 正式对外部署前；本轮不部署 |
| 存量WeKnora资料迁移 | 本轮不迁移，后续显式需求再设计export/import | 需要迁移时，保留原ID映射/引用/ACL |
| 多机高可用 | P0单owner | 达到扩容需求时设计分片与fencing |

这些不妨碍当前代码交接；对应实施门槛仍须验证，不能把已选技术基线当作完整质量验收、生产参数或外部发布授权。

## 复用与许可证

WeKnora主项目为MIT并附第三方许可证列表；Pi Durable包标MIT。真正复制代码/文档/资产时保留所需版权声明，并按复制的具体组件检查第三方条款。独立服务使用自己的名称与标识，不把腾讯品牌或示例截图当成可随意复制的产品资产。

## 需求与决策记录

简要决定写入[spec.md](spec.md)；具体接口事实与方案分别维护于01至05。实施中改变协议版本、发布语义、权限边界、数据模型或验收阈值时，同步更新受影响文档和样例，记录理由与证据。
