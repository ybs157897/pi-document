# 项目决定与任务状态

## 2026-10-16

- 定了（用户）：以WeKnora为参考，用Pi Agent Durable复刻，A2A对外供其他Agent进行文档检索和保存；本轮先整理文档、计划、细节和验收标准，后续在独立work目录实施。
- 定了（已执行）：WeKnora `git pull --ff-only`，SHA为`2fbfb4471581cd5e7d731bc7a2d443fe7d8e95b5`；规划使用独立的 `pi-document-agent` 目录。
- 定了（设计默认，待实施验证）：核心服务P0、扩展P1/P2；Pi负责持久执行，PG负责文档/版本/索引业务数据，blob存原文，A2A适配层对外。
- 否了（设计边界）：不以现成WeKnora HTTP/MCP包装代替Pi独立复刻，不把提交任务视为索引完成，不把Pi恢复误写为外部副作用exactly-once。
- 未决：实际模型与预算、具体parser和中文分词、目标Agent协议兼容性、UI复刻深度；按08和M0解决，不在当前轮实施。
- 判据（本轮）：源码基准可追溯，Pi/A2A版本可核实；规划涵盖功能映射、架构、数据、协议、阶段、故障与真实Agent验收；文件独立落盘，明确未实现/未运行边界。
- 判据（后续P0）：07中的AC-01至26达标并有证据；跨Agent保存→检索→原文、重启恢复、幂等、权限、版本与删除均通过。
- 定了（用户后续授权）：将规划目录提交并推送到 `https://github.com/ybs157897/pi-document.git`，以便在另一台 Mac mini 上 clone 后继续实施；本次授权范围为规划包，不包含产品实施或服务部署。
- 定了（本轮新授权）：克隆 WeKnora，并按实施文档进入开发；原规划包授权边界不再阻止本轮本地实现。
- 定了（本轮模型）：使用 RSI 已配置的阿里云 qwen3.8-flash 做真实模型测试。
- 定了（已验证）：qwen3.8-flash 真实 Pi 工具调用通过，凭据只保存在忽略提交的本地 .env。
- 定了（实施验证）：同一接口的 qwen3.7-text-embedding-flash 实测 1024 维，固定该 profile；Rerank 暂关闭。

- 定了（实施交付）：P0服务和本地验收已完成，状态见11报告；P1/P2仍按路线图。
- 判据（已验证）：137项 npm test、P0 AC-01至26、独立 AC-29、真实Qwen和冻结语料通过；未提交或推送。
- 定了（实施）：同源 `/ui/` 管理界面作为独立 AC-29 交付，不并入 P0 AC-01 至 AC-26；主体/KB 管理、任务、文档和检索页面已实现。
- 判据（浏览器已验证）：`evidence/ui/browser.json` 33项检查通过；包括上传/索引、原文字节、locator、权限撤销、v2、删除、分页、移动端和未知提交恢复。`retry-final.json` 证明generation ready、语义检索命中原文v1且同键重放task稳定。
- 定了（最终验收）：机器报告27/27通过，其中P0 AC-01至26与独立P1 AC-29分开列项；不把其它P1/P2或WeKnora全功能复刻纳入结论。
- 定了（功能边界）：OCR、`document.answer`、Wiki/图谱、数据源同步、SSO与多节点仍未实现；AC-29不代表WeKnora全量 UI。
- 定了（提交授权）：将本轮实现提交并推送当前分支 `codex/document-agent-runtime`，不合并 main。
