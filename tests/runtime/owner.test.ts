import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openOwnedStorage } from '../../src/runtime/owned-storage.js';

test('exclusive Pi owner rejects another process and symlink alias; SIGKILL releases ownership', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-owner-'));
  const filename = join(directory, 'pi.sqlite');
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/runtime/owner-child.ts', filename], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(stderr || 'owner startup timeout')), 5000);
      child.stdout.on('data', chunk => { if (String(chunk).includes('OWNED')) { clearTimeout(timer); resolve(); } });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`owner exited ${code}: ${stderr}`)); });
    });
    await assert.rejects(openOwnedStorage(filename), /PI_STORAGE_ALREADY_OWNED/);
    const alias = join(directory, 'alias.sqlite');
    await symlink(filename, alias);
    await assert.rejects(openOwnedStorage(alias), /PI_STORAGE_ALREADY_OWNED/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const next = await openOwnedStorage(filename);
    await next.close(BACKGROUND_CONTEXT);
  } finally { child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});
