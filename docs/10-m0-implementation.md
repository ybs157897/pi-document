# M0 实施与证据

日期：2026-10-16（Asia/Shanghai）。当前已取得 M0 的依赖、协议表面、Pi 恢复、解析定位、中文词法与真实模型接口证据，本页保留 M0 阶段快照，后续结果见 [实施与验收报告](11-implementation-acceptance.md)。以下试验不能替代完整 AC-02 至 AC-26 产品验收。

## 源码与环境

WeKnora 已克隆到本项目相邻的 `WeKnora` 目录，detached HEAD 固定为 `2fbfb4471581cd5e7d731bc7a2d443fe7d8e95b5`，工作树干净。最初 HTTPS clone 被失效 Git 代理阻断；随后通过现有 SSH 身份成功克隆，未修改代理配置。当前仅参考代码与 MIT 许可证，没有复制 WeKnora 业务源码，也未启动其服务。

Node `24.15.0`、npm `11.12.1`、Pi Durable/Pi AI/Chord `1.3.0`、A2A JS SDK `1.3.0` 精确锁定。操作系统、CPU、ICU、依赖、lock hash、参考许可证 hash 见 [manifest](../evidence/m0/manifest.json)。

## 已运行的门槛

| 表面 | 实测结果 | 证据 |
|---|---|---|
| 干净安装 | 临时空目录 `npm ci` 成功，真实 Pi SQLite open/close 成功；最终依赖审计 0 项告警 | [clean-install.json](../evidence/m0/clean-install.json) |
| 业务合同 | 样例通过；自报租户、缺幂等键、非法 source、超限 topK 拒绝；stored/ready 结果收紧 | `npm run test:contract` |
| Pi 恢复 | 外部收据完成、Pi terminal 未提交时 SIGKILL；重启复用同一 task/receipt；20 次重试不重复；终态重开不再执行 | [pi-durable.json](../evidence/m0/pi-durable.json) |
| Pi owner 与取消 | 第二进程及符号链接别名不能打开同一存储；SIGKILL 自动释放锁；取消等待不取消工作，显式取消另行验证 | `npm run test:runtime` |
| A2A JSON-RPC/SSE | SDK 与原始 HTTP 客户端调用；真实流以快照开始并在终态关闭；版本/方法/参数错误按预期拒绝 | [a2a-runtime.json](../evidence/m0/a2a-runtime.json) |
| 协议差异 | 比对官方 v1.0.0/v1.0.1 与 SDK 1.3.0；未运行官方 TCK，也不宣称全规范合规 | [a2a-source-review.json](../evidence/m0/a2a-source-review.json) |
| 五种解析格式 | TXT/MD/文本 PDF/DOCX/HTML 共 20 个正常/空/损坏/超限样本；另验证实际展开上限、50MiB 边界与 worker 超时；locator 与 Schema 一致 | [parser-matrix.json](../evidence/m0/parser-matrix.json) |
| 中文词法 | 真实 PostgreSQL 17.10，24 份固定文本、46 条查询；40 条精确词/编号命中；6 条同义词无词面命中，未混入语义质量分数 | [lexical-spike.json](../evidence/m0/lexical-spike.json) |
| 真实 Pi 模型 | qwen3.8-flash，1 次请求、1 次实际工具调用、精确原文收据；本次 390 tokens；未核实供应商价格 | [model.json](../evidence/m0/model.json) |
| 真实 Embedding | qwen3.7-text-embedding-flash，3 条中文文本，实际返回 1024 维有限非零向量；随后按固定维度重验 | [embedding.json](../evidence/m0/embedding.json) |
| pgvector | 项目缓存内编译原生 PostgreSQL 17.10 + pgvector 0.8.2，真实扩展与 cosine 排序通过 | [pgvector.json](../evidence/m0/pgvector.json) |

## 实施决定

- Pi 使用官方 SQLite adapter，另以独立 SQLite sidecar 的 exclusive transaction 取得操作系统进程锁；释放和底层 storage.close 绑定，不依靠过期 PID 文件抢锁。Pi 本身的 WAL/NORMAL 不等于掉电零丢失。
- PDF 选 `pdfjs-dist@6.4.299`。DOCX 按原始 XML 的 `w:p` 顺序提取，保留空段落对序号的影响；使用有实际输出上限的 ZIP inflate 与 `cheerio@1.2.0`。Mammoth 的 HTML 输出会省略空段，未采用，已移除依赖。[解析选型记录](../evidence/m0/parser-decisions.json)
- 解析器先使用本项目生成的合法夹具，未使用私有资料。扫描 PDF、OCR、复杂布局保真仍属于后续范围；HTML 字节解析通过不等于 URL 抓取/SSRF 通过。
- 中文词法暂锁 Node/ICU 与 `Intl.Segmenter('zh')`，预分词后用 PG `simple` text search。词法试验明确记录了同义表达的缺口，未伪造语义命中。
- 用户指定 RSI 的 `qwen3.8-flash`；已核对其 provider/model/base URL。凭据只写在本项目 `.env`（0600、Git 忽略），不会自动读取 RSI、Codex 或其他项目的 secret。
- 实际模型目录含 `qwen3.7-text-embedding-flash`，已用该模型验证并固定 1024 维；文档与查询必须使用同一 profile。Rerank 暂不启用，M2 必须显式报告降级，不能声称已验证 Rerank 质量。
- Docker daemon 已可用，但 registry 镜像拉取超时。没有修改系统或 Docker 代理；原生开发依赖仅写 `.cache/`。重建命令为 `npm run setup:postgres`，真实向量验证为 `npm run spike:vector`。这不是生产数据库部署方案。

## 后续门槛

M1 要把以上组件接为持久化业务链路，再验证跨主体权限、业务幂等和重启。M2 才实现混合检索、真实索引发布及上传/URL 管线；M3 验证版本、删除和全部故障窗口。完整 100 文档质量集、10 分钟性能负载、备份恢复、跨 Agent 闭环与 UI 均不得借用本页局部试验标为通过。

模型 profile 是受信任的运维配置，不接受 A2A 客户端传入的 base URL 或凭据名称。所有模型探针使用公开测试短句；报告记录 token 用量，成本字段为未核实，不能解释成免费调用。
