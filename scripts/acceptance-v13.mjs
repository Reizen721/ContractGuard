import { parseOutputDirectory, runAcceptanceSuite } from './lib/acceptance-suite.mjs';

const { exitCode } = await runAcceptanceSuite({
  fixtureDirectory: 'fixtures/v1.3-acceptance',
  manifests: ['cases-01-10.json', 'cases-11-20.json'],
  expectedIds: Array.from({ length: 20 }, (_, index) => `case-${String(index + 1).padStart(2, '0')}`),
  title: 'ContractGuard V1.3：20 个顺序验收案例',
  policyId: 'v13-acceptance',
  outputDirectory: parseOutputDirectory(process.argv.slice(2)),
});
process.exitCode = exitCode;
