export { ProjectRegistry, PROJECT_LIMITS } from './registry.js';
export { runProjectTests } from './runner.js';
export {
  verifyCegarWorkspace,
  type AdversarialProbeEntrypoint,
  type AdversarialWitnessResult,
  type CegarSandboxInput,
  type CegarVerificationReport,
  type CounterexampleKind,
  type SandboxExecutionSummary,
  type VerificationCounterexample,
} from './cegar-sandbox.js';
export { ProjectError } from './errors.js';
export type * from './types.js';
