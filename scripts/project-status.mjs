import { ProjectRegistry } from '../packages/project/dist/index.js';

try {
  const projects = await new ProjectRegistry(process.env.CONTRACTGUARD_PROJECT_CONFIG).list();
  console.log(`[ContractGuard] ${projects.length} trusted project(s) registered. Tests run only when a project review is submitted.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Project registry validation failed.');
  process.exitCode = 1;
}
