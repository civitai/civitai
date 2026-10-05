import path from 'path';
import { defineConfig } from 'vitest/config';

import TestCacheSequencer from '../sequencer.mjs';

// Drives the REAL sequencer, reporter and fs tracker over one fixture, for
// scripts/__tests__/test-cache-e2e.test.ts. Its files end `.e2e.ts`, which the unit project's
// `*.test.ts` include never collects.
const root = path.resolve(__dirname, '../../..');
export default defineConfig({
  test: {
    root,
    name: 'unit-e2e',
    include: ['scripts/test-cache/__e2e__/*.e2e.ts'],
    setupFiles: ['scripts/test-cache/fs-tracker.mjs', 'scripts/test-cache/__e2e__/setup.ts'],
    pool: 'forks',
    sequence: { sequencer: TestCacheSequencer },
  },
});
