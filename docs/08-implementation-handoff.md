# 后续实施交接

## 当前位置

工作目录为本仓库的 clone 根目录，README 示例使用 `~/work/pi-document-agent`。仓库当前只包含规划文件与契约，没有应用源码、依赖安装、数据库或运行中的服务。GitHub 仓库为 `https://github.com/ybs157897/pi-document`。

WeKnora参考目录已更新到 `2fbfb4471581cd5e7d731bc7a2d443fe7d8e95b5`，原工作树干净。后续参考应使用文档里的固定SHA链接，避免上游继续变化影响验收口径。

## 第一轮实施应做什么

从06的M0开始：核实本目录文件、读取当前需求与未决项，锁定Pi/A2A/Node版本，跑最小兼容试验并保存结果。之后完成text save→get→重启→重试不重复的垂直切片。不要先复制整套WeKnora、搬运其私有配置，或仅套一层A2A代理就声称复刻完成。

用户明确使用Pi Durable；不能悄悄换回旧版pi-agent-core loop，也不能以WeKnora现成MCP替代A2A要求。可以复用经过许可证检查的解析模块，独立运行必须在AC-03证明。

## 目标工程结构（尚未创建实现文件）

```text
src/
  app.ts                    # 组装、启动、关闭、恢复
  config/                   # 类型化配置、secret引用
  a2a/                      # discovery、协议SDK适配、task投影
  auth/                     # 服务主体、scope、KB ACL
  runtime/                  # Pi registry、会话、持久task、领域工具
  domain/                   # 文档/知识库用例与错误
  ingestion/                # sources、parser、chunker、index generation
  retrieval/                # lexical、vector、RRF、rerank、citation
  storage/                  # PG repository、blob、outbox、reconciliation
  observability/            # 结构化日志、指标、审计
migrations/
tests/{contract,integration,faults,security,retrieval,e2e}/
fixtures/                   # 合法语料与gold labels
examples/clients/            # SDK客户端、独立HTTP客户端、Agent调用示例
scripts/                    # 评估、故障注入、备份恢复、对账
deploy/                     # compose与生产参数模板
evidence/                   # 真实验收产物，排除secret和私有正文
```

建议将未来验证命令统一为 `typecheck`、`test:contract`、`test:integration`、`test:faults`、`test:security`、`eval:retrieval`、`test:e2e:live`。**这些脚本目前不存在，不能现在运行或声称通过。** 实施时package.json脚本与验收文档必须一致。

## 配置合同（拟定）

| 配置 | 默认/要求 |
|---|---|
| NODE_ENV / HOST / PORT | development / 127.0.0.1 / 实施时选未占用端口；公网地址单独配置 |
| PUBLIC_BASE_URL | AgentCard、引用与上传URL基准；禁止从不可信Host头构造 |
| DATABASE_URL | 专用PG数据库，最小权限；不得使用另一个项目的生产库 |
| PI_STORAGE_PATH | 本项目独立SQLite绝对路径，持久卷，单进程owner |
| BLOB_DRIVER / BLOB_ROOT | local / 本项目data/blobs；S3按环境配置 |
| AGENT_MODEL_PROFILE | 明确provider/modelId/secret引用；natural-language验收必需 |
| EMBEDDING_PROFILE | provider/model/dimensions/normalization/version；更改触发重建 |
| RERANK_PROFILE | 可选，未配置明确降级；不能无声影响测评口径 |
| AUTH_* | 服务端主体与tokenHash、轮换；示例值不可用于生产 |
| INGEST_* / QUERY_* | 文件、解析、并发、超时、预算、topK限额 |
| RETENTION_* | upload/receipt/索引/备份保留与清理期限 |

## 未决事项与默认推进方式

| 事项 | 当前默认 | 何时必须决策 |
|---|---|---|
| 是否要求全部UI一比一 | 服务核心先交付，完整UI列P1/P2 | 开始UI阶段前与用户明确视觉/交互范围 |
| 实际模型和预算 | 不继承其他项目凭据，M0按可用环境选择 | 真实模型测试前；缺凭据则对应测试blocked |
| PDF/DOCX具体parser | 可替换隔离adapter，M0格式试验选型 | 开始M2前；必须核许可证/中文/溯源 |
| A2A目标客户端版本 | 04推荐精确协议基线；SDK不支持不得强行配对 | M0互操作试验；若用户目标Agent固定旧版需明确兼容adapter |
| 中文分词库/词典 | 分词+PG全文，版本化词典 | 检索评估集冻结前 |
| 服务公网部署/SSO | 本机服务token，公网TLS在部署时设置 | 正式对外部署前；本轮不部署 |
| 存量WeKnora资料迁移 | 本轮不迁移，后续显式需求再设计export/import | 需要迁移时，保留原ID映射/引用/ACL |
| 多机高可用 | P0单owner | 达到扩容需求时设计分片与fencing |

这些不妨碍本轮文档完成；对应实施门槛仍须验证，不能把推荐默认当作已经获得生产参数或外部发布授权。

## 复用与许可证

WeKnora主项目为MIT并附第三方许可证列表；Pi Durable包标MIT。真正复制代码/文档/资产时保留所需版权声明，并按复制的具体组件检查第三方条款。独立服务使用自己的名称与标识，不把腾讯品牌或示例截图当成可随意复制的产品资产。

## 需求与决策记录

简要决定写入[spec.md](spec.md)；具体接口事实与方案分别维护于01至05。实施中改变协议版本、发布语义、权限边界、数据模型或验收阈值时，同步更新受影响文档和样例，记录理由与证据。
