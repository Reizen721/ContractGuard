import { parseOutputDirectory, runAcceptanceSuite } from './lib/acceptance-suite.mjs';

const { exitCode } = await runAcceptanceSuite({
  fixtureDirectory: 'fixtures/v1.3-scenarios',
  manifests: ['manifest-part-a.json', 'manifest-part-b.json', 'manifest-part-c.json'],
  expectedIds: ['commerce-checkout', 'catalog-pagination', 'batch-jobs', 'identity-tenancy',
    'multipart-assets', 'iot-telemetry', 'safe-evolution', 'partner-webhooks'],
  title: 'ContractGuard V1.3：8 个复杂业务场景验收',
  policyId: 'v13-scenarios',
  businessScenarios: true,
  outputDirectory: parseOutputDirectory(process.argv.slice(2)),
});
process.exitCode = exitCode;
