import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
export class LocalPostgres {
  private managed = false;
  readonly dataDir: string;
  readonly binDir: string;
  port: number;
  constructor(readonly options: { dataDir: string; binDir?: string; port: number; password: string }) {
    this.dataDir = resolve(options.dataDir); this.binDir = resolve(options.binDir ?? '.cache/postgres/bin'); this.port = options.port;
  }
  async start() {
    await mkdir(dirname(this.dataDir), { recursive: true, mode: 0o700 });
    let initialized = false;
    try { initialized = (await readFile(join(this.dataDir, 'PG_VERSION'), 'utf8')).trim() === '17'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!initialized) {
      const passwordFile = join(dirname(this.dataDir), `.initdb-password-${randomUUID()}`);
      await writeFile(passwordFile, this.options.password, { flag: 'wx', mode: 0o600 });
      try { await exec(join(this.binDir, 'initdb'), ['-D', this.dataDir, '-U', 'postgres', '-A', 'scram-sha-256', `--pwfile=${passwordFile}`, '--encoding=UTF8', '--no-locale'], { timeout: 30_000 }); }
      finally { await unlink(passwordFile); }
    }
    try {
      await exec(join(this.binDir, 'pg_ctl'), ['status', '-D', this.dataDir]);
      this.port = Number((await readFile(join(this.dataDir, 'postmaster.pid'), 'utf8')).split('\n')[3]);
      if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('Invalid existing PostgreSQL port');
      return;
    } catch (error) { if ((error as { code?: number }).code !== 3) throw error; }
    await writeFile(join(this.dataDir, 'postgresql.auto.conf'), `listen_addresses = '127.0.0.1'\nport = ${this.port}\nunix_socket_directories = ''\n`, { mode: 0o600 });
    await exec(join(this.binDir, 'pg_ctl'), ['start', '-D', this.dataDir, '-l', join(this.dataDir, 'server.log'), '-w', '-t', '20'], { timeout: 25_000 });
    this.managed = true;
  }
  get url() { return `postgresql://postgres:${encodeURIComponent(this.options.password)}@127.0.0.1:${this.port}/postgres`; }
  async stop() {
    if (!this.managed) return;
    this.managed = false;
    await exec(join(this.binDir, 'pg_ctl'), ['stop', '-D', this.dataDir, '-m', 'fast', '-w', '-t', '20'], { timeout: 25_000 });
  }
}
