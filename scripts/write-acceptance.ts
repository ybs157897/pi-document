import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';

const read = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'));
const evaluationRuns = (await readdir('evidence/evaluation')).filter(name => name.startsWith('retrieval-')).sort();
const evaluationPath = `evidence/evaluation/${evaluationRuns.at(-1)}/report.json`;
const safeRead = async (path: string) => { try { return await read(path); } catch { return undefined; } };
const [tests, install, evaluation, live, natural, caller, faults, cancel, backup, performance, indexing, ui] = await Promise.all([
  safeRead('evidence/final/product-tests.json'), safeRead('evidence/m0/clean-install.json'), safeRead(evaluationPath),
  safeRead('evidence/m2/live-service.json'), safeRead('evidence/m4/natural-live.json'), safeRead('evidence/m4/caller-agent.json'),
  safeRead('evidence/m3/crash-matrix.json'), safeRead('evidence/m3/cancel-delete-crashes.json'), safeRead('evidence/m4/backup-restore.json'),
  safeRead('evidence/performance/load-10min.json'), safeRead('evidence/performance/indexing.json'), safeRead('evidence/ui/browser.json'),
]);
const status = (value: any): string => value?.status ?? 'not_run';
const gates: Record<string, string> = {
  product: status(tests), install: status(install), quality: status(evaluation), live: status(live), natural: status(natural), caller: status(caller),
  faults: status(faults), cancel: status(cancel), backup: status(backup), load: status(performance), indexing: status(indexing), ui: status(ui),
};
const productEvidence = ['evidence/final/product-tests.json', 'evidence/final/product-tests.log'];
const rows: Array<[string, string, string[], string[], string]> = [
  ['AC-01', '精确依赖与干净安装', ['install'], ['evidence/m0/clean-install.json', 'evidence/m0/manifest.json'], '真实 Pi SQLite open/close，独立空目录 npm ci。'],
  ['AC-02', '独立 A2A 客户端与协议', ['product', 'live'], [...productEvidence, 'evidence/m0/a2a-runtime.json', 'evidence/m2/live-service.json'], 'JS SDK、原生 HTTP/SSE、Python；未运行官方 TCK。'],
  ['AC-03', '脱离 WeKnora 独立运行', ['product', 'live'], ['evidence/m2/live-service.json', 'evidence/final/dev-startup.json'], '独立 Pi/PG/blob；没有使用 WeKnora 服务。'],
  ['AC-04', '创建知识库并保存 Markdown', ['product', 'live', 'caller'], ['evidence/m2/live-service.json', 'evidence/m4/caller-agent.json'], '收据、documentId/version/hash 与原文读回。'],
  ['AC-05', '20 次重试与自然 action 幂等', ['product', 'natural'], [...productEvidence, 'evidence/m4/natural-live.json'], '请求收据与 action hash；不承诺供应商外部调用 exactly-once。'],
  ['AC-06', '异参冲突与跨主体隔离', ['product'], productEvidence, '同键异参冲突；主体间 request/context/task 不串用。'],
  ['AC-07', '五种格式及定位', ['product', 'quality'], [...productEvidence, evaluationPath], '100 份主语料与独立20 HTML快照；不含OCR。'],
  ['AC-08', 'stored 与 indexed 语义', ['product'], productEvidence, 'stored 公开 ingestionTaskId，索引完成后才返回 ready。'],
  ['AC-09', '混合检索与结构化结果', ['product', 'live'], ['evidence/m2/live-service.json', ...productEvidence], '真实 pgvector/Embedding；空词法结果与基础设施失败区分。'],
  ['AC-10', '冻结质量指标', ['quality'], [evaluationPath, 'evidence/evaluation/independent-fixture-review.json'], '85 个有权有答案查询作宏平均；无答案误报单列。'],
  ['AC-11', '引用与版本映射', ['quality'], [evaluationPath], '逐条读回并对照相同版本字节hash和source locator。'],
  ['AC-12', 'Embedding/Rerank 降级', ['product'], productEvidence, 'Embedding失败回退词法；PG查询失败明确失败。Rerank未配置，不宣称真实Reranker超时验收。'],
  ['AC-13', 'topK/filter/分页', ['product'], productEvidence, '有界SQL分页、identity/filter绑定、快照与临时cursor过期清理。'],
  ['AC-14', '权限与资源隔离', ['product', 'live', 'natural'], [...productEvidence, 'evidence/m2/live-service.json', 'evidence/m4/natural-live.json'], '当前ACL覆盖task、SSE、upload、缓存与引用；自然失败无正文结果不污染会话。'],
  ['AC-15', 'URL SSRF 与来源', ['product'], productEvidence, '每跳DNS/IP固定、连接地址验证、重定向/大小/媒体限制；真实example.com来源。'],
  ['AC-16', '更新与并发CAS', ['product', 'quality', 'live'], [...productEvidence, evaluationPath, 'evidence/m2/live-service.json'], '构建期间保留v1，发布后v2，十个版本夹具真实更新。'],
  ['AC-17', '删除/tombstone/purge', ['product', 'cancel'], [...productEvidence, 'evidence/m3/cancel-delete-crashes.json'], '立即隐藏与共享blob清理；自然删除返回安全收据并关闭旧context。'],
  ['AC-18', '终态任务重启可查', ['product', 'faults'], [...productEvidence, 'evidence/m3/crash-matrix.json'], '实际Pi SQLite与PG重开，不重复已完成写入。'],
  ['AC-19', '十个故障窗口标签', ['faults', 'cancel'], ['evidence/m3/crash-matrix.json', 'evidence/m3/cancel-delete-crashes.json'], '30次真实SIGKILL；outbox-handled与Pi commit后PG ACK前共享物理边界。'],
  ['AC-20', '真实 Pi 模型工具调用', ['caller', 'natural'], ['evidence/m4/caller-agent.json', 'evidence/m4/natural-live.json'], 'qwen3.8-flash；外部调用方和服务TextPart分别验证。'],
  ['AC-21', '取消与断流分离', ['product', 'cancel'], [...productEvidence, 'evidence/m3/cancel-delete-crashes.json'], '断流不取消；取消fence禁止后续发布，读取主体可取消自己的任务。'],
  ['AC-22', '恶意/损坏/空/超限', ['product'], productEvidence, '真实格式负例与worker资源/网络约束；macOS网络隔离，不是filesystem sandbox。'],
  ['AC-23', '提示注入隔离', ['product', 'natural'], [...productEvidence, 'evidence/m4/natural-live.json'], '领域授权、明确写意图/否定检查；真实工具轨迹检查无越权写操作。'],
  ['AC-24', '性能和有界预算', ['product', 'load', 'indexing'], [...productEvidence, 'evidence/performance/load-10min.json', 'evidence/performance/indexing.json'], '10k chunks/5客户端/10分钟；合成重复尺寸夹具。请求/token/时长有界，币种账单硬限额未配置。'],
  ['AC-25', '三存储备份恢复', ['product', 'backup'], ['evidence/m4/backup-restore.json', ...productEvidence], '离线逻辑快照、备份后修改、空目标恢复、旧任务/引用与新写；不保证掉电零丢失。'],
  ['AC-26', '两Agent完整链路及接入', ['live', 'natural', 'caller'], ['evidence/m2/live-service.json', 'evidence/m4/natural-live.json', 'evidence/m4/caller-agent.json', 'examples/clients/README.md'], 'writer保存/更新，reader搜索/引用，撤权后拒绝访问。'],
  ['AC-29', '管理 UI', ['product', 'ui'], [...productEvidence, 'evidence/ui/browser.json', 'docs/12-management-ui.md'], '本地同源管理界面；浏览器实测建库、上传、引用、版本、删除、权限和重试。不代表其余 P1/P2 已完成。'],
];
const checks = rows.map(([id, name, requires, evidence, limitation]) => ({ id, name,
  status: requires.every(gate => gates[gate] === 'passed') ? 'passed' : requires.some(gate => gates[gate] === 'failed') ? 'failed' : 'not_run',
  requires: Object.fromEntries(requires.map(gate => [gate, gates[gate]])), evidence, limitation,
}));
const report = { recordedAt: new Date().toISOString(), scope: 'P0 local service plus AC-29 management UI; no other P1/P2, public deployment, or WeKnora quality-parity claim',
  status: checks.every(check => check.status === 'passed') ? 'passed' : 'incomplete', gates, checks,
  evaluation: { path: evaluationPath, summary: evaluation?.results?.summary },
  limitations: ['A2A TCK not_run', 'WeKnora quality comparison not_run', 'No production TLS/SSO deployment', 'No host power-loss durability claim', 'No true reranker service configured', 'No-answer retrieval returns similar candidates; it is not answer abstention'],
};
await mkdir('evidence/final', { recursive: true });
await writeFile('evidence/final/acceptance.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, passed: checks.filter(check => check.status === 'passed').length, total: checks.length, gates }));
