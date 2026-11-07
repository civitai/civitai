import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';

// The permission-hook runner's secret signs every request and response, so a short one is refused
// at boot. Unset or blank (a bare ConfigMap key arrives as '') is accepted and means "no runner":
// every write to a collection with a hook is then refused `hook_unavailable` (fail closed).
describe('STORAGE_HOOK_RUNNER_*', () => {
  const secret = serverSchema.shape.STORAGE_HOOK_RUNNER_SECRET;
  const url = serverSchema.shape.STORAGE_HOOK_RUNNER_URL;

  it('refuses a secret shorter than 32 characters', () => {
    expect(secret.safeParse('short-secret').success).toBe(false);
    expect(secret.safeParse(`${'x'.repeat(31)}  `).success).toBe(false);
  });

  it('accepts a secret of 32 characters or more, unset, or blank', () => {
    for (const value of ['x'.repeat(32), 'y'.repeat(64), undefined, '', '   '])
      expect(secret.safeParse(value).success, JSON.stringify(value)).toBe(true);
  });

  it('takes a URL, unset or blank, and refuses anything else', () => {
    for (const value of ['http://127.0.0.1:8080', undefined, ''])
      expect(url.safeParse(value).success, JSON.stringify(value)).toBe(true);
    expect(url.safeParse('not a url').success).toBe(false);
  });
});
