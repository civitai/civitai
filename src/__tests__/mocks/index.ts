import { resetHybridNodes } from './hybrid';
import { resetEnv } from './env.mock';

export { dbMock } from './db.mock';
export { redisMock } from './redis.mock';
export { loggingMock } from './logging.mock';
export { envMock, setEnv, setEnvDefaults, TEST_ENV_DEFAULTS } from './env.mock';
export { mockNode, hybridNodeCount, type HybridNode } from './hybrid';

/**
 * Called once per test file from src/__tests__/setup.ts, before the test module is
 * imported.
 *
 * Correct in BOTH isolation regimes, and deliberately not built on `globalThis`. With
 * `isolate: true` the module registry is rebuilt per file, so the node registry is empty
 * and this is a no-op — which is right, because a fresh registry needed no reset. With
 * `isolate: false` the registry is the worker's, holds the previous file's implementations
 * and call counts, and this is the only thing that clears them. A `globalThis`-backed
 * cache would silently do nothing under isolation instead.
 */
export function resetSharedMocks() {
  resetHybridNodes();
  // Per-file env overrides only. The worker-level defaults survive, because a module that
  // read one at import time did so once per worker and cannot be re-answered.
  resetEnv();
}
