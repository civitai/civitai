import { vi } from 'vitest';

import { redisOptions } from './redis-like';

export const configured = redisOptions.client;

// Shaped like src/__tests__/setup.ts: a factory that imports a module only when a file imports
// the mocked specifier. factory-loads.e2e.ts does and probe.e2e.ts does not, so the run's
// shared graph hangs factory-dep.ts under this file for both.
vi.mock('./factory-shim', async () => ({ shim: (await import('./factory-dep')).fromFactory }));
