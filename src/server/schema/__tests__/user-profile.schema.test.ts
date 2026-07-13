import { describe, it, expect } from 'vitest';
import { getUserProfileSchema } from '~/server/schema/user-profile.schema';

// Regression guard for the production raw-500 landmine: `userProfile.get`/`.overview`
// were called with `{ username: '' }` (a profile page renders before the username route
// param resolves). The empty string is falsy, so it slipped past the schema, hit the
// service's `!username && !id` guard, threw a plain Error, and surfaced as INTERNAL_SERVER_ERROR
// (500). An empty/absent username is invalid INPUT and must be rejected at the tRPC boundary
// → BAD_REQUEST (400). These assertions FAIL against the old `username: z.string().optional()`
// schema (empty string parsed successfully) and PASS with `.min(1).optional()` + the refine.
describe('getUserProfileSchema', () => {
  it('rejects an empty-string username (the 500 trigger)', () => {
    const res = getUserProfileSchema.safeParse({ username: '' });
    expect(res.success).toBe(false);
  });

  it('rejects both fields absent', () => {
    const res = getUserProfileSchema.safeParse({});
    expect(res.success).toBe(false);
  });

  it('rejects an empty-string username even when id is absent', () => {
    const res = getUserProfileSchema.safeParse({ username: '', id: undefined });
    expect(res.success).toBe(false);
  });

  it('accepts a non-empty username', () => {
    const res = getUserProfileSchema.safeParse({ username: 'civitai' });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.username).toBe('civitai');
  });

  it('accepts an id-only call (username omitted) — legit lookup-by-id path', () => {
    const res = getUserProfileSchema.safeParse({ id: 123 });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.id).toBe(123);
      expect(res.data.username).toBeUndefined();
    }
  });

  it('accepts both username and id present', () => {
    const res = getUserProfileSchema.safeParse({ username: 'civitai', id: 123 });
    expect(res.success).toBe(true);
  });
});
