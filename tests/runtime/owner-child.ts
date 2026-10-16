import { openOwnedStorage } from '../../src/runtime/owned-storage.js';
const storage = await openOwnedStorage(process.argv[2]!);
process.stdout.write('OWNED\n');
setInterval(() => { void storage; }, 1000);
