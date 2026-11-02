// Benchmark-only runner configuration. Upstream's complete type/build suite is
// outside this fixture; the five original GET runtime tests are executed here.
export default { test: { environment: 'node', include: ['test/http-methods/get.test.ts'], restoreMocks: true, fileParallelism: false } };
