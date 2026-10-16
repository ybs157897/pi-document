import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'pi-document-clean-install-'));
const report: Record<string, unknown> = { node: process.version, npm: (await exec('npm', ['--version'])).stdout.trim() };
try {
  for (const file of ['package.json', 'package-lock.json', '.npmrc']) await cp(file, join(directory, file));
  report.lockSha256 = createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
  const installed = await exec('npm', ['ci', '--no-fund'], { cwd: directory, timeout: 180_000 });
  report.installOutput = installed.stdout.trim();
  const verified = await exec(process.execPath, ['--input-type=module', '-e', `
    import { Harness, createRegistry } from '@earendil-works/pi-durable';
    import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
    import { createModels } from '@earendil-works/pi-ai/models';
    import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
    const harness = await Harness.open(await openNodeSqliteStorage('./install-probe.sqlite'), { models: createModels(), registry: createRegistry() }, ctx);
    await harness.root(ctx);
    await harness.close(ctx);
    console.log('PI_SQLITE_OPEN_CLOSE_OK');
  `], { cwd: directory, timeout: 20_000 });
  if (!verified.stdout.includes('PI_SQLITE_OPEN_CLOSE_OK')) throw new Error('SQLite probe did not confirm success');
  report.status = 'passed'; report.piSqlite = 'open/close passed in clean installed directory';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
  await mkdir('evidence/m0', { recursive: true });
  await writeFile('evidence/m0/clean-install.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
