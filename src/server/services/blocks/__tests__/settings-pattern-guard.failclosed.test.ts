import { describe, expect, it, vi } from 'vitest';

// Isolated from the sibling real-recheck suite: force recheck to return an
// `unknown` verdict (its status when analysis errors or times out) and prove the
// guard fails CLOSED — an unanalyzable pattern is treated as vulnerable, NOT
// accepted. Without this, a pattern crafted to stall recheck's own analysis would
// bypass the submission gate and reach the eval-time `.test()`.
vi.mock('recheck', () => ({
  check: vi.fn(async () => ({
    status: 'unknown',
    checker: 'fuzz',
    error: { kind: 'timeout' },
  })),
}));

import { isPatternRedosVulnerable } from '~/server/services/blocks/settings-pattern-guard';

describe('isPatternRedosVulnerable — fail-closed on unknown', () => {
  it('treats an unanalyzable (recheck "unknown" / timeout) pattern as vulnerable', async () => {
    expect(await isPatternRedosVulnerable('(some-unanalyzable-pattern)')).toBe(true);
  });
});
