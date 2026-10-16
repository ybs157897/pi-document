import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const root = process.cwd();
const prefix = resolve('.cache/postgres');
const sources = [
  { name: 'postgres', repository: 'https://github.com/postgres/postgres.git', tag: 'REL_17_10', commit: '25c49f3a4a742ba283f5cc43cc7f1d361552e917' },
  { name: 'pgvector', repository: 'https://github.com/pgvector/pgvector.git', tag: 'v0.8.2', commit: 'cab9da72c04353f143bb06b42ab70a403daac64a' },
];
await mkdir('.cache/dependencies', { recursive: true });
for (const source of sources) {
  const directory = resolve('.cache/dependencies', source.name);
  try { await access(directory); } catch { await exec('git', ['clone', '--depth', '1', '--branch', source.tag, source.repository, directory], { maxBuffer: 10_000_000 }); }
  const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
  if (head !== source.commit) throw new Error(`${source.name} checkout does not match pinned source`);
}
const build = async (command: string, args: string[], directory: string) => {
  console.log(JSON.stringify({ event: 'build', component: directory.split('/').pop(), command, args }));
  try { await exec(command, args, { cwd: directory, maxBuffer: 32_000_000 }); }
  catch (error) { console.error((error as { stderr?: string }).stderr?.slice(-6000)); throw new Error(`${command} failed; source retained under .cache/dependencies`); }
};
const pg = resolve(root, '.cache/dependencies/postgres');
await build('./configure', [`--prefix=${prefix}`, '--without-icu', '--without-readline', '--without-zlib'], pg);
await build('make', ['-j4'], pg); await build('make', ['install'], pg);
const vector = resolve(root, '.cache/dependencies/pgvector');
await build('make', ['-j4', `PG_CONFIG=${prefix}/bin/pg_config`, 'OPTFLAGS='], vector);
await build('make', [`PG_CONFIG=${prefix}/bin/pg_config`, 'install'], vector);
console.log(JSON.stringify({ event: 'ready', binDir: `${prefix}/bin`, postgres: '17.10', pgvector: '0.8.2' }));
