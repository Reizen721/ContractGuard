import { getOasdiffStatus } from '../packages/oasdiff/dist/index.js';
const status = await getOasdiffStatus();
console.log(status.available
  ? `[ContractGuard] Agent engine ready: oasdiff ${status.version}.`
  : '[ContractGuard] Agent engine unavailable. Run pnpm engine:install. Classic analysis can still start.');
