import { openProbe } from './probe-task.js';
const directory = process.argv[2]!;
const probe = await openProbe(directory, async () => {
  process.stdout.write('EFFECT_COMMITTED\n');
  await new Promise(() => {});
});
await probe.admit('crash-key');
probe.harness.resume();
setInterval(() => {}, 1000);
