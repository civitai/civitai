import { describe, it, expect } from 'vitest';
import { constants } from '~/server/common/constants';
import { getUserProfileSchema, userProfileUpdateSchema } from '~/server/schema/user-profile.schema';

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

describe('userProfileUpdateSchema showcaseItems', () => {
  const limit = constants.profile.showcaseItemsLimit;
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ entityType: 'Model' as const, entityId: i + 1 }));

  it('accepts a showcase at the limit', () => {
    expect(userProfileUpdateSchema.safeParse({ showcaseItems: items(limit) }).success).toBe(true);
  });

  it('rejects a showcase over the limit', () => {
    const res = userProfileUpdateSchema.safeParse({ showcaseItems: items(limit + 1) });
    expect(res.success).toBe(false);
    if (!res.success)
      expect(
        res.error.issues.map((issue) => ({ code: issue.code, path: issue.path }))
      ).toContainEqual({ code: 'too_big', path: ['showcaseItems'] });
  });
});

describe('the About text', () => {
  it('keeps text formatting and links but drops media', () => {
    const { about } = userProfileUpdateSchema.parse({
      about:
        '<h2>Hi</h2><p><strong>me</strong> <a href="https://x.test">x</a></p><img src="a.png"><iframe src="https://www.youtube.com/embed/1"></iframe>',
    });
    expect(about).toContain('<h2>Hi</h2>');
    expect(about).toContain('<strong>me</strong>');
    expect(about).toContain('href="https://x.test"');
    expect(about).not.toMatch(/<img|<iframe/);
  });
});

describe('the page theme', () => {
  const parse = (pageTheme: unknown) => userProfileUpdateSchema.safeParse({ pageTheme }).success;

  it('takes a colour, an opacity on its own, or both, per theme', () => {
    expect(parse({ dark: { color: '#112233', opacity: 80 } })).toBe(true);
    expect(parse({ light: { opacity: 70 } })).toBe(true);
  });

  it('takes a sidebar colour on its own', () => {
    expect(parse({ sidebar: { color: '#1b2a4a' } })).toBe(true);
    expect(parse({ sidebar: {} })).toBe(false);
  });

  it('refuses a theme with neither, an opacity out of range, or a colour that is not hex', () => {
    expect(parse({ dark: {} })).toBe(false);
    expect(parse({ dark: { opacity: 50 } })).toBe(false);
    expect(parse({ dark: { color: 'red' } })).toBe(false);
  });
});
