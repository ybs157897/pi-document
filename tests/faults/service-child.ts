import { readFile } from 'node:fs/promises';
import { startApp } from '../../src/app.js';
import type { ServiceConfig } from '../../src/config/service.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { TaskId } from '@earendil-works/pi-durable';

const input = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as ServiceConfig & { faultPoint?: string };
let fired = false;
const app = await startApp({ ...input, fault: async point => {
  if (!fired && input.faultPoint === point) {
    fired = true;
    await new Promise<void>(() => {
      if (!process.send) throw new Error('Fault child requires an IPC channel');
      process.send({ event: 'fault', point }, undefined, undefined, () => { process.kill(process.pid, 'SIGKILL'); });
    });
  }
} });
process.send?.({ event: 'ready', baseUrl: app.baseUrl });
process.on('message', async (message: { event: string; taskId?: number }) => {
  if (message.event === 'shutdown') { await app.close(); process.exit(0); }
  if (message.event === 'inspect' && message.taskId !== undefined) {
    const task = await app.runtime.harness.getTask(message.taskId as TaskId, BACKGROUND_CONTEXT);
    process.send?.({ event: 'inspect', taskId: message.taskId, state: task?.state.status });
  }
});
