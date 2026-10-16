import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeDocx } from './parser-spike.js';
import { parseSource, type SourceLocator } from '../src/ingestion/parser.js';

type Language = 'zh' | 'en' | 'mixed';
type Format = 'txt' | 'md' | 'pdf' | 'docx';
type Scenario = 'filter' | 'permission';

interface Topic {
  key: string;
  code: string;
  titleZh: string;
  titleEn: string;
  metricZh: string;
  metricEn: string;
  unit: string;
  values: string[];
  delta: number;
  precision: number;
  altZh: string;
  altEn: string;
  conditionZh: string;
  conditionEn: string;
  actionZh: string;
  actionEn: string;
  assetZh: string;
  assetEn: string;
  logPrefix: string;
  tag: string;
}

interface SourceDocument {
  key: string;
  code: string;
  format: Format;
  language: Language;
  access: 'public' | 'restricted';
  knowledgeBaseRole: 'public' | 'restricted';
  title: string;
  path: string;
  tags: string[];
  topicKey: string;
  siteZh: string;
  siteEn: string;
  assetZh: string;
  assetEn: string;
  valueV1: string;
  valueV2: string;
  metricZh: string;
  metricEn: string;
  unit: string;
  reviewMinutes: number;
  factZh: string;
  factEn: string;
  actionZh: string;
  actionEn: string;
  link?: { code: string; role: 'control' | 'assembly'; zh: string; en: string };
  fileSha256?: string;
  byteSize?: number;
  supports?: Array<{ id: string; text: string; version: number; sha256: string; locator: SourceLocator; range: { startOffset: number; endOffset: number } }>;
}

interface QueryFixture {
  id: string;
  query: string;
  category: 'exact' | 'synonym' | 'cross_passage_document' | 'version' | 'no_answer' | 'filter_permission';
  scenario?: Scenario;
  language: Language;
  split: 'development' | 'blind';
  expectedDocumentKeys: string[];
  expectedFormats: Format[];
  expectedKnowledgeBaseRole?: 'public' | 'restricted';
  expectedOutcome: 'results' | 'no_answer' | 'permission_denied' | 'results_after_update';
  supportText: string[];
  acceptableSourceLocators: Array<{
    documentKey: string;
    version: number;
    sha256: string;
    container: SourceLocator;
    range: { startOffset: number; endOffset: number };
  }>;
  expectedVersion?: number;
  versionFixtureId?: string;
  principalRole: 'evaluator' | 'reader';
  filters?: { tags?: string[]; sourceTypes?: Array<'upload'> };
  note?: string;
}

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(projectRoot, 'fixtures', 'evaluation');
const frozenRoot = join(fixtureRoot, 'frozen');
const pdfHelper = join(fixtureRoot, 'generate-pdf.py');
const parserSpike = join(projectRoot, 'scripts', 'parser-spike.ts');
const python = process.env.EVAL_PYTHON?.trim() || 'python3';
const blindSeed = 'pi-document-evaluation-v1-blind-2026-10';
const languagePattern: Language[] = ['zh', 'en', 'zh', 'mixed', 'zh', 'en', 'zh', 'en', 'zh', 'zh'];
const formats: Array<{ format: Format; count: number }> = [
  { format: 'txt', count: 20 },
  { format: 'md', count: 30 },
  { format: 'pdf', count: 30 },
  { format: 'docx', count: 20 },
];
const regionZh = ['北河', '青港', '松湾', '银桥', '南圃', '云岭', '东堤', '石岗', '滨林', '柳湾'];
const regionEn = ['North Basin', 'Cedar Quay', 'Pine Bay', 'Silver Bridge', 'South Orchard', 'Cloud Ridge', 'East Levee', 'Stone Hill', 'Riverwood', 'Willow Cove'];
const conditionZh = ['夜班交接后', '暴雨值守期间', '月度校准后', '设备重启后', '周末轮检时', '高峰负载下', '备用切换后', '冷启动阶段', '季度盘点时', '维修复验后'];
const conditionEn = ['after night-shift handover', 'during the storm watch', 'after monthly calibration', 'after equipment restart', 'during weekend rotation', 'under peak load', 'after standby switchover', 'during cold start', 'at quarterly inventory', 'after repair verification'];
const letters = 'ABCDEFGHIJ'.split('');

const topics: Topic[] = [
  {
    key: 'water', code: 'WTR', titleZh: '市政供水泵站巡检', titleEn: 'Municipal water-pump inspection',
    metricZh: '出水压力', metricEn: 'outlet pressure', unit: 'MPa', values: ['0.42', '0.46', '0.39', '0.51', '0.44', '0.48', '0.41', '0.53', '0.45', '0.38'], delta: 0.03, precision: 2,
    altZh: '泵口水压', altEn: 'pressure at the pump outlet', conditionZh: conditionZh[0]!, conditionEn: conditionEn[0]!,
    actionZh: '偏离目标两次时切换并联备用泵', actionEn: 'switch to the parallel standby pump after two out-of-range readings',
    assetZh: '增压泵', assetEn: 'booster pump', logPrefix: 'WATER-LOG', tag: 'sector-water',
  },
  {
    key: 'cold-chain', code: 'CLD', titleZh: '冷链仓配温控记录', titleEn: 'Cold-chain distribution temperature record',
    metricZh: '箱内温度', metricEn: 'cargo-bay temperature', unit: '°C', values: ['-18', '-16', '-20', '-19', '-17', '-21', '-15', '-22', '-18', '-17'], delta: 1, precision: 0,
    altZh: '冷藏货物的温度设定', altEn: 'temperature setting for chilled cargo', conditionZh: conditionZh[1]!, conditionEn: conditionEn[1]!,
    actionZh: '开门累计超过八分钟时重新封签', actionEn: 'reseal the load after more than eight cumulative minutes with the door open',
    assetZh: '冷藏箱', assetEn: 'refrigerated container', logPrefix: 'COLD-LOG', tag: 'sector-cold-chain',
  },
  {
    key: 'transit', code: 'BUS', titleZh: '城市公交车辆调度', titleEn: 'City-bus dispatch control',
    metricZh: '发车电量下限', metricEn: 'minimum departure charge', unit: '%', values: ['68', '72', '65', '75', '70', '64', '78', '69', '73', '66'], delta: 3, precision: 0,
    altZh: '车辆离站时的剩余储能', altEn: 'remaining battery energy when a vehicle leaves the depot', conditionZh: conditionZh[2]!, conditionEn: conditionEn[2]!,
    actionZh: '低于门槛时先安排补电再排班', actionEn: 'schedule a recharge before assigning a bus below the threshold',
    assetZh: '纯电公交', assetEn: 'electric bus', logPrefix: 'TRANSIT-LOG', tag: 'sector-transit',
  },
  {
    key: 'clinic', code: 'MED', titleZh: '基层诊所冷藏药品管理', titleEn: 'Community-clinic medicine storage',
    metricZh: '药品柜温度', metricEn: 'medicine-cabinet temperature', unit: '°C', values: ['4', '5', '3', '6', '4', '2', '5', '3', '6', '4'], delta: 1, precision: 0,
    altZh: '疫苗保冷环境', altEn: 'cold-storage conditions for vaccine stock', conditionZh: conditionZh[3]!, conditionEn: conditionEn[3]!,
    actionZh: '温度越界时隔离该批次并复核冷柜', actionEn: 'quarantine the batch and recheck the cabinet after a temperature excursion',
    assetZh: '药品冷柜', assetEn: 'medicine refrigerator', logPrefix: 'CLINIC-LOG', tag: 'sector-clinic',
  },
  {
    key: 'flood', code: 'FLD', titleZh: '城市防洪闸门值守', titleEn: 'Urban flood-gate watch',
    metricZh: '闸前水位上限', metricEn: 'upstream gate level limit', unit: 'm', values: ['2.8', '3.1', '2.6', '3.3', '2.9', '3.5', '2.7', '3.0', '3.2', '2.5'], delta: 0.2, precision: 1,
    altZh: '闸门上游蓄水位', altEn: 'reservoir level on the upstream side of the gate', conditionZh: conditionZh[4]!, conditionEn: conditionEn[4]!,
    actionZh: '接近上限时通知堤防值守组', actionEn: 'notify the levee watch team as the reading approaches the limit',
    assetZh: '防洪闸', assetEn: 'flood gate', logPrefix: 'FLOOD-LOG', tag: 'sector-flood',
  },
  {
    key: 'solar', code: 'SOL', titleZh: '分布式光伏逆变器巡检', titleEn: 'Distributed-solar inverter inspection',
    metricZh: '并网告警电压', metricEn: 'grid-alarm voltage', unit: 'V', values: ['224', '228', '221', '231', '226', '219', '233', '223', '229', '222'], delta: 4, precision: 0,
    altZh: '逆变器触发告警的电压门槛', altEn: 'voltage threshold that triggers the inverter alarm', conditionZh: conditionZh[5]!, conditionEn: conditionEn[5]!,
    actionZh: '越过门槛时保存波形并隔离支路', actionEn: 'save the waveform and isolate the branch when the threshold is crossed',
    assetZh: '并网逆变器', assetEn: 'grid-tied inverter', logPrefix: 'SOLAR-LOG', tag: 'sector-solar',
  },
  {
    key: 'rail', code: 'RAIL', titleZh: '支线铁路信号维护', titleEn: 'Branch-rail signaling maintenance',
    metricZh: '信号回路响应上限', metricEn: 'signal-loop response limit', unit: 'ms', values: ['82', '76', '91', '70', '88', '79', '94', '73', '85', '68'], delta: 5, precision: 0,
    altZh: '轨道信号电路允许的延迟', altEn: 'permitted delay in the rail signaling circuit', conditionZh: conditionZh[6]!, conditionEn: conditionEn[6]!,
    actionZh: '响应超时即封锁该区段并检查继电器', actionEn: 'block the segment and inspect the relay when response is late',
    assetZh: '轨道信号继电器', assetEn: 'track-signal relay', logPrefix: 'RAIL-LOG', tag: 'sector-rail',
  },
  {
    key: 'archive', code: 'ARC', titleZh: '地方档案库环境巡检', titleEn: 'Regional archive-room inspection',
    metricZh: '纸张保存相对湿度', metricEn: 'relative humidity for paper storage', unit: '%', values: ['48', '45', '51', '46', '49', '43', '52', '47', '44', '50'], delta: -2, precision: 0,
    altZh: '纸本文档适宜的空气含水程度', altEn: 'moisture level suited to preserving paper records', conditionZh: conditionZh[7]!, conditionEn: conditionEn[7]!,
    actionZh: '偏离区间时启动除湿并复查温湿度计', actionEn: 'start dehumidification and recheck the sensor when outside the range',
    assetZh: '纸本文档库房', assetEn: 'paper-records room', logPrefix: 'ARCHIVE-LOG', tag: 'sector-archive',
  },
  {
    key: 'robot', code: 'ROB', titleZh: '仓储巷道机器人安全巡检', titleEn: 'Warehouse-aisle robot safety check',
    metricZh: '巷道行驶速度上限', metricEn: 'aisle travel-speed limit', unit: 'm/s', values: ['0.8', '1.0', '0.7', '1.1', '0.9', '0.6', '1.2', '0.85', '0.95', '0.75'], delta: 0.1, precision: 2,
    altZh: '机器人在货架通道内允许的行进节奏', altEn: 'permitted pace for a robot moving between warehouse racks', conditionZh: conditionZh[8]!, conditionEn: conditionEn[8]!,
    actionZh: '人员进入通道时降至步行速度', actionEn: 'reduce to walking speed when a person enters the aisle',
    assetZh: '搬运机器人', assetEn: 'pallet robot', logPrefix: 'ROBOT-LOG', tag: 'sector-robot',
  },
  {
    key: 'habitat', code: 'HAB', titleZh: '河流栖息地水样监测', titleEn: 'River-habitat water-sample monitoring',
    metricZh: '河段浊度参考值', metricEn: 'reference turbidity for the river reach', unit: 'NTU', values: ['3.2', '4.1', '2.8', '5.0', '3.7', '4.6', '2.5', '5.3', '3.5', '4.0'], delta: 0.4, precision: 1,
    altZh: '河水看起来浑浊的程度', altEn: 'how cloudy the river water may become', conditionZh: conditionZh[9]!, conditionEn: conditionEn[9]!,
    actionZh: '超过参考值时加采上游对照样本', actionEn: 'collect an upstream comparison sample when above the reference value',
    assetZh: '河段采样点', assetEn: 'river-reach sampling point', logPrefix: 'HABITAT-LOG', tag: 'sector-habitat',
  },
];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function fileLanguage(formatIndex: number): Language {
  return languagePattern[formatIndex % languagePattern.length]!;
}

function formatForIndex(index: number): { format: Format; formatIndex: number } {
  let offset = 0;
  for (const item of formats) {
    if (index < offset + item.count) return { format: item.format, formatIndex: index - offset };
    offset += item.count;
  }
  throw new Error('EVALUATION_DOCUMENT_INDEX_INVALID');
}

function valueWithDelta(value: string, delta: number, precision: number): string {
  return (Number(value) + delta).toFixed(precision);
}

function makeDocument(index: number): SourceDocument {
  const topic = topics[Math.floor(index / 10)]!;
  const itemIndex = index % 10;
  const { format, formatIndex } = formatForIndex(index);
  const language = fileLanguage(formatIndex);
  const key = `doc-${String(index + 1).padStart(3, '0')}`;
  const code = `EV-${topic.code}-${String(itemIndex + 1).padStart(2, '0')}`;
  const siteZh = `${regionZh[itemIndex]}${topic.key === 'water' ? '供水站' : topic.key === 'cold-chain' ? '冷配点' : topic.key === 'transit' ? '公交场站' : topic.key === 'clinic' ? '社区诊所' : topic.key === 'flood' ? '防洪站' : topic.key === 'solar' ? '光伏场' : topic.key === 'rail' ? '支线区段' : topic.key === 'archive' ? '档案库' : topic.key === 'robot' ? '仓储区' : '河段监测点'}`;
  const siteEn = `${regionEn[itemIndex]} ${topic.key === 'water' ? 'Pump Station' : topic.key === 'cold-chain' ? 'Cold Depot' : topic.key === 'transit' ? 'Bus Depot' : topic.key === 'clinic' ? 'Community Clinic' : topic.key === 'flood' ? 'Flood Station' : topic.key === 'solar' ? 'Solar Field' : topic.key === 'rail' ? 'Rail Segment' : topic.key === 'archive' ? 'Archive Room' : topic.key === 'robot' ? 'Warehouse' : 'River Reach'}`;
  const valueV1 = topic.values[itemIndex]!;
  const reviewMinutes = 7 + itemIndex * 3;
  const assetZh = `${topic.assetZh}${letters[itemIndex]}`;
  const assetEn = `${topic.assetEn} ${letters[itemIndex]}`;
  const factZh = `记录 ${code}：${regionZh[itemIndex]} ${topic.metricZh} ${valueV1} ${topic.unit}；${reviewMinutes} 分钟内复核。`;
  const factEn = `${code} ${regionEn[itemIndex]}: ${topic.metricEn} ${valueV1} ${topic.unit}; review within ${reviewMinutes} min.`;
  const actionZh = `${conditionZh[itemIndex]}，${topic.actionZh}；读数记入 ${topic.logPrefix}-${String(index + 1).padStart(3, '0')}。`;
  const actionEn = `${conditionEn[itemIndex]}, ${topic.actionEn}; log readings in ${topic.logPrefix}-${String(index + 1).padStart(3, '0')}.`;
  const tags = [topic.tag, `format-${format}`, `language-${language}`, `region-${String(itemIndex + 1).padStart(2, '0')}`];
  const access = index >= 5 && index < 10 ? 'restricted' : 'public';
  if (index < 5) tags.push(`benchmark-filter-${String(index + 1).padStart(2, '0')}`);
  return {
    key, code, format, language, access, knowledgeBaseRole: access, title: language === 'en' ? `${topic.titleEn}: ${siteEn}` : `${topic.titleZh}：${siteZh}`,
    path: `documents/${key}.${format}`, tags, topicKey: topic.key, siteZh, siteEn, assetZh, assetEn,
    valueV1, valueV2: valueWithDelta(valueV1, topic.delta, topic.precision), metricZh: topic.metricZh,
    metricEn: topic.metricEn, unit: topic.unit, reviewMinutes, factZh, factEn, actionZh, actionEn,
  };
}

function textForDocument(document: SourceDocument, version: 1 | 2 = 1): { title: string; paragraphs: string[]; factZh: string; factEn: string } {
  const topic = topics.find(item => item.key === document.topicKey)!;
  const value = version === 1 ? document.valueV1 : document.valueV2;
  const itemIndex = (Number(document.key.slice(-3)) - 1) % 10;
  const factZh = `记录 ${document.code}：${regionZh[itemIndex]} ${document.metricZh} ${value} ${document.unit}；${document.reviewMinutes} 分钟内复核。`;
  const factEn = `${document.code} ${regionEn[itemIndex]}: ${document.metricEn} ${value} ${document.unit}; review within ${document.reviewMinutes} min.`;
  const titleZh = `${topic.titleZh}：${document.siteZh}`;
  const titleEn = `${topic.titleEn}: ${document.siteEn}`;
  const revisionZh = `修订版本：v${version}。记录编号：${document.code}。`;
  const revisionEn = `Revision v${version}. Record ${document.code}.`;
  const siteZh = `地点：${document.siteZh}；设备：${document.assetZh}。`;
  const siteEn = `Site: ${document.siteEn}; asset: ${document.assetEn}.`;
  const paragraphs = document.language === 'zh'
    ? [titleZh, revisionZh, siteZh, factZh, document.actionZh]
    : document.language === 'en'
      ? [titleEn, revisionEn, siteEn, factEn, document.actionEn]
      : [
        `${titleZh} / ${titleEn}`,
        `${revisionZh} ${revisionEn}`,
        `${siteZh} ${siteEn}`,
        factZh,
        factEn,
        document.actionZh,
        document.actionEn,
      ];
  if (document.link) {
    if (document.language === 'zh') paragraphs.push(document.link.zh);
    else if (document.language === 'en') paragraphs.push(document.link.en);
    else paragraphs.push(document.link.zh, document.link.en);
  }
  return { title: document.title, paragraphs, factZh, factEn };
}

function outputBytes(format: Format, title: string, paragraphs: string[]): Buffer | undefined {
  if (format === 'txt') return Buffer.from(paragraphs.join('\n\n') + '\n', 'utf8');
  if (format === 'md') return Buffer.from(`# ${title}\n\n${paragraphs.slice(1).join('\n\n')}\n`, 'utf8');
  if (format === 'docx') return makeDocx([
    { text: title, style: 'Heading1' },
    ...paragraphs.slice(1).map(text => ({ text })),
  ]);
  return undefined;
}

function mimeForFormat(format: Format): string {
  switch (format) {
    case 'txt': return 'text/plain';
    case 'md': return 'text/markdown';
    case 'pdf': return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
}

async function locateSupport(bytes: Buffer, format: Format, supportText: string, version: 1 | 2): Promise<{
  version: number; sha256: string; locator: SourceLocator; range: { startOffset: number; endOffset: number };
}> {
  const parsed = await parseSource(bytes, mimeForFormat(format));
  const index = parsed.text.indexOf(supportText);
  if (index < 0) throw new Error(`EVALUATION_SUPPORT_TEXT_NOT_FOUND:${format}`);
  const startOffset = Array.from(parsed.text.slice(0, index)).length;
  const endOffset = startOffset + Array.from(supportText).length;
  const span = parsed.spans.find(item => item.startOffset <= startOffset && item.endOffset >= endOffset);
  if (!span) throw new Error(`EVALUATION_SUPPORT_LOCATOR_NOT_FOUND:${format}`);
  return { version, sha256: sha256(bytes), locator: span.locator, range: { startOffset, endOffset } };
}

function shaText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function supportTextFor(document: SourceDocument, language: Language, kind: 'fact' | 'link'): string {
  if (kind === 'link') {
    if (!document.link) throw new Error('EVALUATION_LINK_SUPPORT_MISSING');
    return language === 'en' ? document.link.en : document.link.zh;
  }
  return language === 'en' ? document.factEn : document.factZh;
}

function queryPhrase(document: SourceDocument): string {
  switch (document.language) {
    case 'zh': return `查询${document.siteZh}的${document.topicKey === 'water' ? '泵口水压' : topics.find(topic => topic.key === document.topicKey)!.altZh}。`;
    case 'en': return `What is the ${topics.find(topic => topic.key === document.topicKey)!.altEn} at ${document.siteEn}?`;
    case 'mixed': return `${document.siteZh} / ${document.siteEn}: ${topics.find(topic => topic.key === document.topicKey)!.altZh} (${topics.find(topic => topic.key === document.topicKey)!.altEn})?`;
  }
}

function queryEntry(input: {
  id: string;
  query: string;
  category: QueryFixture['category'];
  language: Language;
  documents?: SourceDocument[];
  supports?: string[];
  versions?: number[];
  hashes?: string[];
  locators?: SourceLocator[];
  ranges?: Array<{ startOffset: number; endOffset: number }>;
  expectedOutcome?: QueryFixture['expectedOutcome'];
  expectedKnowledgeBaseRole?: QueryFixture['expectedKnowledgeBaseRole'];
  principalRole?: QueryFixture['principalRole'];
  filters?: QueryFixture['filters'];
  scenario?: Scenario;
  expectedVersion?: number;
  versionFixtureId?: string;
  note?: string;
}): QueryFixture {
  const documents = input.documents ?? [];
  const supportText = input.supports ?? [];
  const locators = input.locators ?? [];
  const ranges = input.ranges ?? [];
  const versions = input.versions ?? documents.map(() => 1);
  const hashes = input.hashes ?? documents.map(document => document.fileSha256 ?? '');
  return {
    id: input.id,
    query: input.query,
    category: input.category,
    ...(input.scenario ? { scenario: input.scenario } : {}),
    language: input.language,
    split: 'development',
    expectedDocumentKeys: documents.map(document => document.key),
    expectedFormats: [...new Set(documents.map(document => document.format))].sort(),
    ...(input.expectedKnowledgeBaseRole ? { expectedKnowledgeBaseRole: input.expectedKnowledgeBaseRole } : {}),
    expectedOutcome: input.expectedOutcome ?? 'results',
    supportText,
    acceptableSourceLocators: documents.map((document, index) => ({
      documentKey: document.key,
      version: versions[index]!,
      sha256: hashes[index]!,
      container: locators[index]!,
      range: ranges[index]!,
    })),
    ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
    ...(input.versionFixtureId ? { versionFixtureId: input.versionFixtureId } : {}),
    principalRole: input.principalRole ?? 'evaluator',
    ...(input.filters ? { filters: input.filters } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
}

function asRecord(record: SourceDocument): Record<string, unknown> {
  return {
    key: record.key,
    code: record.code,
    format: record.format,
    language: record.language,
    access: record.access,
    knowledgeBaseRole: record.knowledgeBaseRole,
    title: record.title,
    path: record.path,
    sha256: record.fileSha256,
    byteSize: record.byteSize,
    tags: record.tags,
    topicKey: record.topicKey,
    supportPassages: record.supports,
  };
}

async function listDataFiles(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error('EVALUATION_FIXTURE_SYMLINK_NOT_ALLOWED');
    if (info.isDirectory()) result.push(...await listDataFiles(root, full));
    else if (info.isFile()) result.push(relative(root, full).split(sep).join('/'));
    else throw new Error('EVALUATION_FIXTURE_ENTRY_INVALID');
  }
  return result.sort();
}

function writePdfInputPath(stageRoot: string): string {
  return join(stageRoot, '.pdf-input.json');
}

async function generate(): Promise<void> {
  await mkdir(fixtureRoot, { recursive: true });
  try {
    await access(frozenRoot, fsConstants.F_OK);
    throw new Error('EVALUATION_FIXTURES_ALREADY_FROZEN');
  } catch (error) {
    if (error instanceof Error && error.message === 'EVALUATION_FIXTURES_ALREADY_FROZEN') throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const stageRoot = await mkdtemp(join(fixtureRoot, '.staging-'));
  let published = false;
  try {
    const docsRoot = join(stageRoot, 'documents');
    const updatesRoot = join(stageRoot, 'updates');
    await mkdir(docsRoot, { recursive: true });
    await mkdir(updatesRoot, { recursive: true });
    const documents = Array.from({ length: 100 }, (_, index) => makeDocument(index));
    const pdfInput: Array<{ path: string; title: string; paragraphs: string[] }> = [];

    const crossDocuments = documents.slice(50, 90);
    const crossByLanguage = new Map<Language, SourceDocument[]>([['zh', []], ['en', []], ['mixed', []]]);
    for (const document of crossDocuments) crossByLanguage.get(document.language)!.push(document);
    let pairNumber = 0;
    const linkKeys: Array<{ left: SourceDocument; right: SourceDocument }> = [];
    for (const language of ['zh', 'en', 'mixed'] as const) {
      const group = crossByLanguage.get(language)!;
      if (group.length % 2 !== 0) throw new Error('EVALUATION_CROSS_LANGUAGE_COUNT_NOT_EVEN');
      for (let index = 0; index < group.length; index += 2) {
        pairNumber += 1;
        const left = group[index]!;
        const right = group[index + 1]!;
        const linkCode = `LINK-${String(pairNumber).padStart(3, '0')}`;
        const controlRoom = `Control ${String(pairNumber).padStart(2, '0')}`;
        const assemblyPoint = regionEn[(pairNumber + 2) % 10]!;
        const gateNumber = (pairNumber % 8) + 1;
        const switchLimit = 5 + (pairNumber % 13);
        left.link = {
          code: linkCode, role: 'control',
          zh: `关联 ${linkCode}：控制室 ${pairNumber} 的备援切换限时 ${switchLimit} 分钟。`,
          en: `${linkCode} control-room backup switch limit: ${switchLimit} minutes.`,
        };
        right.link = {
          code: linkCode, role: 'assembly',
          zh: `关联 ${linkCode}：集合点位于${regionZh[(pairNumber + 2) % 10]}的 ${gateNumber} 号门。`,
          en: `${linkCode} assembly point: gate ${gateNumber} at ${assemblyPoint}.`,
        };
        linkKeys.push({ left, right });
      }
    }

    for (const document of documents) {
      const rendered = textForDocument(document, 1);
      const bytes = outputBytes(document.format, rendered.title, rendered.paragraphs);
      if (document.format === 'pdf') {
        pdfInput.push({ path: document.path, title: rendered.title, paragraphs: rendered.paragraphs });
      } else if (bytes) {
        await writeFile(join(stageRoot, document.path), bytes, { flag: 'wx', mode: 0o600 });
      }
      document.factZh = rendered.factZh;
      document.factEn = rendered.factEn;
    }

    const versionDocuments = documents.slice(90);
    const versionCases: Array<{ document: SourceDocument; queryId: string; oldValue: string; newValue: string; v2Path: string }> = [];
    for (const document of versionDocuments) {
      const rendered = textForDocument(document, 2);
      const v2Path = `updates/${document.key}-v2.${document.format}`;
      const bytes = outputBytes(document.format, rendered.title, rendered.paragraphs);
      if (bytes) await writeFile(join(stageRoot, v2Path), bytes, { flag: 'wx', mode: 0o600 });
      else pdfInput.push({ path: v2Path, title: rendered.title, paragraphs: rendered.paragraphs });
      versionCases.push({ document, queryId: `version-${document.key}`, oldValue: document.valueV1, newValue: document.valueV2, v2Path });
    }

    await writeJson(writePdfInputPath(stageRoot), { documents: pdfInput });
    const pythonArgs = [pdfHelper, writePdfInputPath(stageRoot), stageRoot];
    try {
      await execFileAsync(python, pythonArgs, { cwd: projectRoot, timeout: 120_000, maxBuffer: 4_000_000 });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.slice(-2000) ?? '';
      throw new Error(`EVALUATION_PDF_GENERATION_FAILED${stderr ? `:${stderr}` : ''}`);
    }
    await rm(writePdfInputPath(stageRoot), { force: true });

    for (const document of documents) {
      const bytes = await readFile(join(stageRoot, document.path));
      document.fileSha256 = sha256(bytes);
      document.byteSize = bytes.byteLength;
      const rendered = textForDocument(document, 1);
      const supports = [
        ...(document.language === 'en' ? [{ id: 'fact_en', text: rendered.factEn }] : [{ id: 'fact_zh', text: rendered.factZh }]),
        ...(document.language === 'mixed' ? [{ id: 'fact_en', text: rendered.factEn }] : []),
        ...(document.link && document.language !== 'en' ? [{ id: 'link_zh', text: document.link.zh }] : []),
        ...(document.link && document.language !== 'zh' ? [{ id: 'link_en', text: document.link.en }] : []),
      ];
      document.supports = [];
      for (const support of supports) {
        const located = await locateSupport(bytes, document.format, support.text, 1);
        document.supports.push({ id: support.id, text: support.text, ...located });
      }
    }

    const queryLocators = new Map<string, Map<string, Awaited<ReturnType<typeof locateSupport>>>>();
    for (const document of documents) {
      const bySupport = new Map<string, Awaited<ReturnType<typeof locateSupport>>>();
      for (const support of document.supports ?? []) bySupport.set(support.id, support);
      queryLocators.set(document.key, bySupport);
    }

    const queries: QueryFixture[] = [];
    for (const document of documents.slice(0, 20)) {
      const support = supportTextFor(document, document.language, 'fact');
      const anchor = queryLocators.get(document.key)!.get(document.language === 'en' ? 'fact_en' : 'fact_zh')!;
      const query = document.language === 'zh'
        ? `记录 ${document.code} 中的运行阈值是多少？`
        : document.language === 'en'
          ? `Retrieve the operating threshold in record ${document.code}.`
          : `Record ${document.code}: 运行阈值 / operating threshold?`;
      queries.push(queryEntry({ id: `exact-${document.key}`, query, category: 'exact', language: document.language,
        documents: [document], supports: [support], locators: [anchor.locator], ranges: [anchor.range] }));
    }

    for (const document of documents.slice(20, 50)) {
      const topic = topics.find(item => item.key === document.topicKey)!;
      const support = supportTextFor(document, document.language, 'fact');
      const anchor = queryLocators.get(document.key)!.get(document.language === 'en' ? 'fact_en' : 'fact_zh')!;
      const query = queryPhrase(document);
      queries.push(queryEntry({ id: `synonym-${document.key}`, query, category: 'synonym', language: document.language,
        documents: [document], supports: [support], locators: [anchor.locator], ranges: [anchor.range],
        note: `Curated paraphrase of ${document.language === 'en' ? topic.metricEn : topic.metricZh}; authored before any retrieval run.` }));
    }

    for (let index = 0; index < linkKeys.length; index += 1) {
      const { left, right } = linkKeys[index]!;
      const code = left.link!.code;
      const textFor = (document: SourceDocument) => supportTextFor(document, document.language, 'link');
      const supportLeft = textFor(left);
      const supportRight = textFor(right);
      const locLeft = queryLocators.get(left.key)!.get(left.language === 'en' ? 'link_en' : 'link_zh')!;
      const locRight = queryLocators.get(right.key)!.get(right.language === 'en' ? 'link_en' : 'link_zh')!;
      const query = left.language === 'zh'
        ? `对于 ${code}，备援切换最多用时多少分钟，集合点在哪个门？`
        : left.language === 'en'
          ? `For ${code}, what are the backup-switch limit and assembly gate?`
          : `For ${code}, 备援切换时限与 assembly gate 分别是什么？`;
      queries.push(queryEntry({ id: `cross-${code}`, query, category: 'cross_passage_document', language: left.language,
        documents: [left, right], supports: [supportLeft, supportRight], locators: [locLeft.locator, locRight.locator],
        ranges: [locLeft.range, locRight.range], note: 'The two independently authored passages are joined by a fixed synthetic case identifier.' }));
    }

    const versionFixtureEntries: Array<Record<string, unknown>> = [];
    for (const item of versionCases) {
      const document = item.document;
      const topic = topics.find(topicItem => topicItem.key === document.topicKey)!;
      const rendered = textForDocument(document, 2);
      const v2Bytes = await readFile(join(stageRoot, item.v2Path));
      const v2Sha = sha256(v2Bytes);
      const v2Fact = document.language === 'en' ? rendered.factEn : rendered.factZh;
      const v2Anchor = await locateSupport(v2Bytes, document.format, v2Fact, 2);
      const query = document.language === 'zh'
        ? `更新后 ${document.siteZh} 的${topic.altZh}新阈值是多少？`
        : document.language === 'en'
          ? `After the revision, what is the ${topic.altEn} limit at ${document.siteEn}?`
          : `Revision 2: ${document.siteZh} / ${document.siteEn} 的新阈值是多少？`;
      queries.push(queryEntry({ id: item.queryId, query, category: 'version', language: document.language,
        documents: [document], supports: [v2Fact], versions: [2], hashes: [v2Sha], locators: [v2Anchor.locator],
        ranges: [v2Anchor.range], expectedVersion: 2, versionFixtureId: `update-${document.key}`,
        expectedOutcome: 'results_after_update', expectedKnowledgeBaseRole: document.knowledgeBaseRole,
        note: 'Requires a real document.update v1-to-v2 operation; the runner must report not_run while M3 is unavailable.' }));
      versionFixtureEntries.push({
        fixtureId: `update-${document.key}`,
        documentKey: document.key,
        format: document.format,
        language: document.language,
        fromVersion: 1,
        toVersion: 2,
        baselinePath: document.path,
        baselineSha256: document.fileSha256,
        version1Value: item.oldValue,
        version2Path: item.v2Path,
        version2Sha256: v2Sha,
        version2ByteSize: v2Bytes.byteLength,
        supportText: v2Fact,
        acceptableSourceLocator: { container: v2Anchor.locator, range: v2Anchor.range },
        queryId: item.queryId,
      });
    }

    const noAnswerQuestions: Array<{ query: string; language: Language }> = [
      { query: '月面种子库的氦气瓶压力记录是多少？', language: 'zh' },
      { query: 'What color was the orbital bakery umbrella on the first survey day?', language: 'en' },
      { query: '火星观测站的咖啡豆库存是否超过 900 袋？', language: 'zh' },
      { query: 'How many blue umbrellas were stored in the lunar seed vault?', language: 'en' },
      { query: '南极月壤样本由哪一艘潜艇运送？', language: 'zh' },
      { query: 'Which bakery sold the cobalt telescope on Mars?', language: 'en' },
      { query: '月球档案员在 2014 年借出的黑胶唱片数量是多少？', language: 'zh' },
      { query: 'Did the orbital greenhouse order 700 copper kites?', language: 'en' },
      { query: '月面厨房的咖啡豆 shipment 到达了哪座火星机场？', language: 'mixed' },
      { query: 'What was the Antarctic submarine name in the lunar bakery ledger?', language: 'zh' },
    ];
    for (let index = 0; index < noAnswerQuestions.length; index += 1) {
      const item = noAnswerQuestions[index]!;
      queries.push(queryEntry({ id: `no-answer-${String(index + 1).padStart(2, '0')}`, query: item.query,
        category: 'no_answer', language: item.language, expectedOutcome: 'no_answer',
        note: 'No supporting passage exists in the frozen corpus; these concepts were reserved for abstention checks.' }));
    }

    for (let index = 0; index < 5; index += 1) {
      const document = documents[index]!;
      const support = supportTextFor(document, document.language, 'fact');
      const anchor = queryLocators.get(document.key)!.get(document.language === 'en' ? 'fact_en' : 'fact_zh')!;
      const filterTag = `benchmark-filter-${String(index + 1).padStart(2, '0')}`;
      queries.push(queryEntry({ id: `filter-${document.key}`, query: queryPhrase(document), category: 'filter_permission',
        scenario: 'filter', language: document.language, documents: [document], supports: [support], locators: [anchor.locator],
        ranges: [anchor.range], filters: { tags: [filterTag], sourceTypes: ['upload'] },
        note: 'The tag filter isolates this preselected document; it was assigned before retrieval.' }));
    }

    for (let index = 5; index < 10; index += 1) {
      const document = documents[index]!;
      const support = supportTextFor(document, document.language, 'fact');
      const anchor = queryLocators.get(document.key)!.get(document.language === 'en' ? 'fact_en' : 'fact_zh')!;
      queries.push(queryEntry({ id: `permission-${document.key}`, query: queryPhrase(document), category: 'filter_permission',
        scenario: 'permission', language: document.language, documents: [document], supports: [support], locators: [anchor.locator],
        ranges: [anchor.range], expectedKnowledgeBaseRole: 'restricted', expectedOutcome: 'permission_denied', principalRole: 'reader',
        note: 'The reader has read access to the public evaluation KB but is intentionally not a member of this restricted KB.' }));
    }

    if (queries.length !== 100) throw new Error(`EVALUATION_QUERY_COUNT_INVALID:${queries.length}`);
    const blindCounts = new Map<string, number>([
      ['exact', 4], ['synonym', 6], ['cross_passage_document', 4], ['version', 2], ['no_answer', 2],
      ['filter_permission:filter', 1], ['filter_permission:permission', 1],
    ]);
    const blindIds = new Set<string>();
    for (const [bucket, count] of blindCounts) {
      const candidates = queries.filter(query => {
        const currentBucket = query.category === 'filter_permission' ? `${query.category}:${query.scenario}` : query.category;
        return currentBucket === bucket;
      }).sort((left, right) => shaText(`${blindSeed}:${left.id}`).localeCompare(shaText(`${blindSeed}:${right.id}`)));
      if (candidates.length < count) throw new Error(`EVALUATION_BLIND_SPLIT_BUCKET_INVALID:${bucket}`);
      for (const query of candidates.slice(0, count)) blindIds.add(query.id);
    }
    for (const query of queries) query.split = blindIds.has(query.id) ? 'blind' : 'development';

    const pdfInputAfterUpdates = pdfInput.filter(item => item.path.startsWith('documents/'));
    if (pdfInputAfterUpdates.length !== 30) throw new Error(`EVALUATION_PDF_COUNT_INVALID:${pdfInputAfterUpdates.length}`);
    if (documents.filter(document => document.language === 'zh').length !== 60
      || documents.filter(document => document.language === 'en').length !== 30
      || documents.filter(document => document.language === 'mixed').length !== 10) {
      throw new Error('EVALUATION_DOCUMENT_LANGUAGE_COUNTS_INVALID');
    }

    await writeJson(join(stageRoot, 'corpus.json'), { fixtureVersion: 1, description: 'Original, legally distributable synthetic retrieval corpus; it is not representative evidence for real enterprise documents.', documents: documents.map(asRecord) });
    await writeJson(join(stageRoot, 'queries.json'), { fixtureVersion: 1, blindSplitSeed: blindSeed, queries });
    await writeJson(join(stageRoot, 'updates.json'), { fixtureVersion: 1, description: 'Ten explicit v1-to-v2 document source fixtures. These are not executed until the M3 update API is available.', transitions: versionFixtureEntries });

    const dataFiles = await listDataFiles(stageRoot);
    const fileEntries: Array<{ path: string; sha256: string; byteSize: number }> = [];
    for (const path of dataFiles) {
      const bytes = await readFile(join(stageRoot, path));
      fileEntries.push({ path, sha256: sha256(bytes), byteSize: bytes.byteLength });
    }
    const datasetHash = shaText(fileEntries.map(entry => `${entry.path}\t${entry.sha256}\t${entry.byteSize}`).join('\n') + '\n');
    const generatorSource = await readFile(fileURLToPath(import.meta.url));
    const pdfSource = await readFile(pdfHelper);
    const parserHelperSource = await readFile(parserSpike);
    const byFormat: Record<Format, number> = { txt: 0, md: 0, pdf: 0, docx: 0 };
    const byLanguage: Record<Language, number> = { zh: 0, en: 0, mixed: 0 };
    const matrix: Record<Format, Record<Language, number>> = {
      txt: { zh: 0, en: 0, mixed: 0 }, md: { zh: 0, en: 0, mixed: 0 }, pdf: { zh: 0, en: 0, mixed: 0 }, docx: { zh: 0, en: 0, mixed: 0 },
    };
    for (const document of documents) { byFormat[document.format] += 1; byLanguage[document.language] += 1; matrix[document.format][document.language] += 1; }
    const byCategory: Record<string, number> = {};
    const byQueryLanguage: Record<Language, number> = { zh: 0, en: 0, mixed: 0 };
    const bySplit: Record<'development' | 'blind', number> = { development: 0, blind: 0 };
    for (const query of queries) {
      byCategory[query.category] = (byCategory[query.category] ?? 0) + 1;
      byQueryLanguage[query.language] += 1;
      bySplit[query.split] += 1;
    }
    const manifest = {
      fixtureVersion: 1,
      frozen: true,
      datasetSha256: datasetHash,
      blindSplit: { seed: blindSeed, strategy: 'pre-retrieval SHA-256 rank within query category and filter/permission subcategory', developmentQueries: bySplit.development, blindQueries: bySplit.blind },
      counts: {
        documents: documents.length,
        documentsByFormat: byFormat,
        documentsByLanguage: byLanguage,
        formatLanguageMatrix: matrix,
        queries: queries.length,
        queriesByCategory: byCategory,
        queriesByLanguage: byQueryLanguage,
        queriesBySplit: bySplit,
        versionTransitions: versionFixtureEntries.length,
      },
      files: fileEntries,
      generationSources: {
        generatorSha256: sha256(generatorSource),
        pdfHelperSha256: sha256(pdfSource),
        docxHelperSha256: sha256(parserHelperSource),
      },
      restrictions: [
        'The corpus is synthetic and does not prove retrieval quality on real enterprise documents.',
        'Twenty blind queries are frozen before retrieval tuning and must not be used to select parameters.',
        'Version queries are fixtures only until the M3 v1-to-v2 update path is implemented and executed.',
        'The five permission cases use reader identity against a KB without membership; no results are expected.',
      ],
    };
    await writeJson(join(stageRoot, 'manifest.json'), manifest);
    await rename(stageRoot, frozenRoot);
    published = true;
    console.log(JSON.stringify({ status: 'frozen', datasetSha256: datasetHash, counts: manifest.counts, frozenRoot: relative(projectRoot, frozenRoot) }));
  } finally {
    if (!published) await rm(stageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await generate();
}
