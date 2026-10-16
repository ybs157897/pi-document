# Pi Document Agent：WeKnora 复刻实施包

本目录是后续实施工作目录。本轮交付为设计、契约样例、计划和验收标准，**尚未实现服务、部署服务或通过运行验收**。

## 目标

以 Pi Durable 为 Agent 与任务运行时，复刻 WeKnora 的文档知识能力，通过标准 A2A 让其他 Agent 保存资料、检索资料并取得可追溯原文。服务拥有自己的知识库和存储，可在停止原 WeKnora 后独立工作。

用户已明确：采用 Pi Durable、A2A 对外、支持保存和检索，先整理规划再实施。此规划包已获授权提交到 `ybs157897/pi-document`；产品代码实施与服务部署尚未开始。

## 在另一台 Mac 上继续

```bash
mkdir -p ~/work
cd ~/work
git clone https://github.com/ybs157897/pi-document.git pi-document-agent
cd pi-document-agent
```

这里的 clone 目录就是后续实施根目录，不要求与调研机器的路径相同。先阅读本 README、实施交接与 M0 计划；当前只有规划和契约，尚无应用启动或依赖安装命令。

## 阅读顺序

1. [能力映射与源码依据](docs/01-weknora-capability-map.md)：复刻对象、完整功能分层、源码定位。
2. [Pi Durable 运行时](docs/02-pi-durable-runtime.md)：版本、真实 API、恢复机制及缺口。
3. [产品边界与架构](docs/03-product-architecture.md)：交互、组件、权限与技术取舍。
4. [A2A 契约](docs/04-a2a-contract.md)：协议版本、发现、任务、消息与例子。
5. [数据与处理流程](docs/05-data-and-pipelines.md)：保存、检索、版本、删除与一致性。
6. [分阶段实施计划](docs/06-implementation-plan.md)：依赖、交付物、退出门槛。
7. [验收标准](docs/07-acceptance.md)：可执行场景、指标、故障注入与证据。
8. [实施交接](docs/08-implementation-handoff.md)：第一步、目标目录、启动参数与未决项。
9. [本轮检查记录](docs/09-planning-validation.md)：规划工件已验证什么、运行验收尚缺什么。

[契约说明](contracts/README.md)、[请求 Schema](contracts/document-request.schema.json)、[结果 Schema](contracts/document-result.schema.json) 与 [A2A 样例](contracts/examples/) 是规划工件，不是已经存在的 API。A2A 外壳服从协议，`Part.data` 承载本项目业务合同。契约变更需同步例子和验收用例。

## 复刻范围

P0 交付可独立使用的 Agent 文档服务：知识库、保存、解析、混合检索、引用、版本更新与删除、权限、任务持久化、A2A 互操作。P1 补齐问答、复杂格式、批量管理与简易管理界面。P2 跟进 Wiki、知识图谱、数据源同步、完整管理体验与生态渠道。

这是按当前用途拟定的实施顺序，**不把 P0 称为 WeKnora 全量一比一复刻**。完整 UI、全部连接器和所有格式均需按能力映射逐项验收。用户可在实施前调整优先级，无需重做底层合同。

## 来源与状态

- 检查日期：2026-10-16（Asia/Shanghai）。
- WeKnora：`https://github.com/Tencent/WeKnora.git`，`main`，`2fbfb4471581cd5e7d731bc7a2d443fe7d8e95b5`。`git pull --ff-only` 返回 `Already up to date.`；工作树干净，`HEAD...origin/main = 0 0`。
- 参考源码：独立的 [Tencent/WeKnora](https://github.com/Tencent/WeKnora) checkout；本仓库保留固定 SHA 的源码链接，不依赖调研机器的绝对路径。
- Pi Durable：推荐精确锁定 `@earendil-works/pi-durable@1.3.0`（上游SHA `71023aec1546d6d677a65669c5665c0927ce0dd0`）；本地参照安装为 `1.1.0`，未升级。版本与源码核验细节见运行时文档。
- 本仓库是独立项目目录，不内嵌在 WeKnora 中；上述命令默认放在 `~/work/pi-document-agent`。
- 已核实的是代码与协议材料；模型质量、性能、解析兼容性和跨 Agent 调用仍是后续实施验收项。

后续可直接在本目录开展 M0。先锁定协议与依赖并建立最小持久化垂直切片，再依次执行阶段门槛。
