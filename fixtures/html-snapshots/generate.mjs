import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const frozenRoot = join(fixtureRoot, 'frozen');
const languagePattern = ['zh', 'en', 'mixed', 'zh', 'en', 'zh', 'mixed', 'zh', 'en', 'zh', 'mixed', 'zh', 'en', 'zh', 'mixed', 'zh', 'en', 'zh', 'mixed', 'zh'];
const records = [
  ['社区水站巡检快照', '供水压力', '北岸阀室的夜班供水压力为 0.44 MPa，复核周期为 12 分钟。', '查询 HTML-SNAP-001 北岸阀室的供水压力。'],
  ['冷链交接记录', '温控读数', 'Cold Depot COLD-02 kept the sample bay at 3 °C; the handover check closes within 9 minutes.', 'What temperature did HTML-SNAP-002 cold depot record?'],
  ['青禾公交场站快照', '电量门槛', 'HTML-SNAP-003：车辆出库电量不得低于 71%；Green Route 需要在发车前复核。', 'For HTML-SNAP-003, what is the departure battery threshold?'],
  ['社区诊所药柜快照', '冷藏批次', 'HTML-SNAP-004 记录药柜温度为 4 °C，异常时先隔离疫苗批次。', '查询 HTML-SNAP-004 的药柜温度与异常动作。'],
  ['东堤水闸巡查快照', '上游水位', 'HTML-SNAP-005：东堤闸前水位为 2.7 米，超过 3.1 米时通知值守组。', '查询 HTML-SNAP-005 闸前水位上限。'],
  ['Solar Field S06 Snapshot', 'Inverter alarm', 'HTML-SNAP-006: inverter alarm threshold is 229 V; preserve the waveform on an excursion.', 'What alarm threshold is listed in HTML-SNAP-006?'],
  ['石岗信号维护快照', '区段延迟', 'HTML-SNAP-007：轨道回路响应上限为 84 ms，超时后封锁支线区段。', 'HTML-SNAP-007 的轨道回路响应上限是多少？'],
  ['Regional Archive A08 Snapshot', 'Paper storage', 'For HTML-SNAP-008, paper storage humidity is 47%; recheck the sensor after dehumidification.', 'What humidity target does HTML-SNAP-008 record?'],
  ['仓储机器人快照', '通道速度', 'HTML-SNAP-009：搬运机器人速度上限为 0.85 m/s；人员进入巷道后降速。', 'HTML-SNAP-009 规定的通道速度上限是什么？'],
  ['Willow Cove Water Snapshot', 'River sample', 'HTML-SNAP-010 River Reach reference turbidity is 3.8 NTU; take an upstream comparison sample above the mark.', 'What reference turbidity is recorded in HTML-SNAP-010?'],
  ['滨林光伏点快照', '并网读数', 'HTML-SNAP-011：光伏逆变器在 226 V 时触发复核，并保存当次波形。', 'HTML-SNAP-011 的逆变器复核电压是多少？'],
  ['Bus Depot B12 Snapshot', 'Route reserve', 'HTML-SNAP-012 reserves 74% charge for the Cedar Loop departure after the morning handover.', 'How much charge is reserved in HTML-SNAP-012?'],
  ['南圃档案室快照', '纸张湿度', 'HTML-SNAP-013：南圃纸本文档库房维持 49% 相对湿度，超界后启动除湿。', 'HTML-SNAP-013 的档案湿度目标是多少？'],
  ['East Levee Gate Snapshot', 'Storm watch', 'HTML-SNAP-014 gate upstream level limit is 3.2 m; call the watch team within five minutes of a warning.', 'What level limit applies to HTML-SNAP-014?'],
  ['云岭冷藏点快照', '样本箱读数', 'HTML-SNAP-015：样本箱温度保持在 -18 °C，开门累计超过 8 分钟须重新封签。', 'HTML-SNAP-015 的冷藏温度和封签规则是什么？'],
  ['银桥社区诊所快照', '药品柜校准', 'HTML-SNAP-016：药品柜设定为 5 °C；每周三核对校准签。', 'HTML-SNAP-016 药品柜的设定温度是多少？'],
  ['Stone Hill Rail Snapshot', 'Signal relay', 'HTML-SNAP-017 permits 79 ms signal-loop response; block the segment when a reading exceeds that limit.', 'Which response limit is recorded in HTML-SNAP-017?'],
  ['河湾采样快照', '水样浊度', 'HTML-SNAP-018：河湾采样点浊度参考值为 4.4 NTU，超限后加采上游对照样本。', 'HTML-SNAP-018 的河水浊度参考值是多少？'],
  ['Riverwood Cold Depot Snapshot', 'Door seal', 'HTML-SNAP-019 limits the cargo-bay temperature to -17 °C; reseal after seven cumulative open-door minutes.', 'What temperature and reseal interval does HTML-SNAP-019 specify?'],
  ['南岸水站快照', '备用泵切换', 'HTML-SNAP-020：南岸水站出水压力为 0.41 MPa；连续两次偏差后切换备用泵。', 'HTML-SNAP-020 的供水压力和备用泵规则是什么？'],
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  try {
    await readFile(join(frozenRoot, 'manifest.json'));
    throw new Error('HTML_SNAPSHOT_FIXTURES_ALREADY_FROZEN');
  } catch (error) {
    if (error instanceof Error && error.message === 'HTML_SNAPSHOT_FIXTURES_ALREADY_FROZEN') throw error;
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(fixtureRoot, { recursive: true });
  const stage = await mkdtemp(join(fixtureRoot, '.staging-'));
  let published = false;
  try {
    const snapshots = [];
    for (let index = 0; index < records.length; index += 1) {
      const [title, section, supportText, query] = records[index];
      const number = String(index + 1).padStart(3, '0');
      const key = `html-snap-${number}`;
      const fragment = `evidence-${number}`;
      const language = languagePattern[index];
      const filename = `${number}.html`;
      const html = `<!doctype html>\n<html lang="${language === 'en' ? 'en' : 'zh-CN'}">\n<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>\n<body>\n<main>\n<h1 id="page-${number}">${escapeHtml(title)}</h1>\n<h2 id="${fragment}">${escapeHtml(section)}</h2>\n<p>${escapeHtml(supportText)}</p>\n<p>Fixture ${key} is synthetic, locally supplied, and intended only to check HTML block and fragment locators.</p>\n</main>\n</body>\n</html>\n`;
      const bytes = Buffer.from(html, 'utf8');
      await writeFile(join(stage, filename), bytes, { flag: 'wx', mode: 0o600 });
      snapshots.push({
        key,
        path: filename,
        format: 'html',
        language,
        title,
        sha256: sha256(bytes),
        byteSize: bytes.byteLength,
        tags: ['html-snapshot', `language-${language}`],
        query,
        supportText,
        expectedLocator: { kind: 'html_section', headingPath: [title, section], fragment },
      });
    }
    const files = [];
    for (const snapshot of snapshots) {
      const bytes = await readFile(join(stage, snapshot.path));
      files.push({ path: snapshot.path, sha256: sha256(bytes), byteSize: bytes.byteLength });
    }
    const datasetSha256 = sha256(Buffer.from(files.map(file => `${file.path}\t${file.sha256}\t${file.byteSize}`).join('\n') + '\n', 'utf8'));
    const generatorSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
    await writeJson(join(stage, 'manifest.json'), {
      fixtureVersion: 1,
      frozen: true,
      datasetSha256,
      counts: {
        snapshots: snapshots.length,
        languages: snapshots.reduce((counts, snapshot) => ({ ...counts, [snapshot.language]: counts[snapshot.language] + 1 }), { zh: 0, en: 0, mixed: 0 }),
      },
      transport: 'A2A upload of frozen synthetic HTML snapshot files',
      publicUrlFetchCoverage: 'not covered here; these files do not claim 20 public source URLs',
      files,
      snapshots,
      generatorSha256,
      limitations: [
        'These local synthetic snapshots verify HTML parser output and locator fragments through upload and search.',
        'They do not exercise HTTP URL fetching, DNS resolution, redirect handling, or public website availability.',
      ],
    });
    await rename(stage, frozenRoot);
    published = true;
    process.stdout.write(`${JSON.stringify({ status: 'frozen', datasetSha256, snapshots: snapshots.length })}\n`);
  } finally {
    if (!published) await rm(stage, { recursive: true, force: true });
  }
}

await main();
