import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import os from 'node:os';

const reference = resolve(process.env.WEKNORA_REFERENCE_PATH ?? '../WeKnora');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const baseline = '2fbfb4471581cd5e7d731bc7a2d443fe7d8e95b5';
const head = git(reference, 'rev-parse', 'HEAD');
if (head !== baseline || git(reference, 'status', '--porcelain')) throw new Error('Reference checkout must be clean and match the implementation baseline');
const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const sourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(path => /^(src\/|web\/|migrations\/|scripts\/|tests\/|contracts\/|config\/|fixtures\/|docs\/|README\.md$|package(?:-lock)?\.json$|tsconfig\.json$|\.env\.example$)/.test(path)).sort();
const sourceHashes = await Promise.all(sourceFiles.map(async path => ({ path, sha256: hash(await readFile(path)) })));
const manifest = {
  recordedAt: new Date().toISOString(), timezone: 'Asia/Shanghai',
  environment: { platform: process.platform, architecture: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem(), node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), icu: process.versions.icu },
  reference: { repository: 'https://github.com/Tencent/WeKnora.git', commit: head, clean: true, licenseSha256: hash(await readFile(resolve(reference, 'LICENSE'))), copiedSourceComponents: [] },
  project: { baseCommit: git(process.cwd(), 'rev-parse', 'HEAD'), dirty: !!git(process.cwd(), 'status', '--porcelain'), lockSha256: hash(await readFile('package-lock.json')) },
  implementation: { sha256: hash(JSON.stringify(sourceHashes)), files: sourceHashes },
  nativeDatabase: { postgres: '17.10', postgresSource: '25c49f3a4a742ba283f5cc43cc7f1d361552e917', pgvector: '0.8.2', pgvectorSource: 'cab9da72c04353f143bb06b42ab70a403daac64a' },
  dependencies: pkg.dependencies, devDependencies: pkg.devDependencies,
  protocol: { specification: '1.0.1', wireVersion: '1.0', sdk: '1.3.0' },
};
await mkdir('evidence/m0', { recursive: true });
await writeFile('evidence/m0/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('evidence/m0/manifest.json');
