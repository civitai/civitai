import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';

// The runner's secret is checked on every mint, so a short one is refused at boot; a blank one
// (a bare ConfigMap key arrives as '') is accepted and answered as "not configured" (503) by the
// mint endpoint, so it cannot take the whole app down.
const field = serverSchema.shape.ASSISTANT_RUNNER_SECRET;

describe('ASSISTANT_RUNNER_SECRET', () => {
  it('refuses a secret shorter than 32 characters', () => {
    expect(field.safeParse('short-secret').success).toBe(false);
    expect(field.safeParse(`${'x'.repeat(31)}  `).success).toBe(false);
  });

  it('accepts 32 characters or more, unset, or blank', () => {
    for (const value of ['x'.repeat(32), 'y'.repeat(64), undefined, '', '   '])
      expect(field.safeParse(value).success, JSON.stringify(value)).toBe(true);
  });
});
