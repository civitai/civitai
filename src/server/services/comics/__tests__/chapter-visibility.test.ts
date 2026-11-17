import { describe, expect, it, vi } from 'vitest';

// Each list belongs to reader 2 alone, so a lookup made for the wrong viewer finds nothing.
const { listOf } = vi.hoisted(() => ({
  listOf: (ids: number[]) => ({
    getCached: async ({ userId }: { userId?: number }) =>
      userId === 2 ? ids.map((id) => ({ id })) : [],
  }),
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenUsers: listOf([21]),
  BlockedByUsers: listOf([22]),
  BlockedUsers: listOf([23]),
}));

const { isComicProjectHidden, isPanelTainted } = await import(
  '~/server/services/comics/chapter-visibility'
);

const OWNER = 5;
const project = (over: Record<string, unknown> = {}) => ({
  userId: OWNER,
  status: 'Active',
  tosViolation: false,
  publishedAt: new Date(),
  user: { bannedAt: null },
  ...over,
});
const reader = { id: 2 };
const owner = { id: OWNER };
const moderator = { id: 9, isModerator: true };

describe('a comic project', () => {
  it('is shown to a reader when nothing holds it back (control)', async () => {
    expect(await isComicProjectHidden(project(), reader)).toBe(false);
    expect(await isComicProjectHidden(project(), undefined)).toBe(false);
  });

  const held: [string, Record<string, unknown>][] = [
    ['taken down for ToS', { tosViolation: true }],
    ['by a banned author', { user: { bannedAt: new Date() } }],
    ['never published', { publishedAt: null }],
    ['by a creator the reader hid', { userId: 21 }],
    ['by a creator who blocked the reader', { userId: 22 }],
    ['by a creator the reader blocked', { userId: 23 }],
  ];

  it.each(held)('is hidden from a reader when %s', async (_, over) => {
    expect(await isComicProjectHidden(project(over), reader)).toBe(true);
  });

  it.each([21, 22, 23])(
    "applies reader 2's hide and block lists to reader 2 only (creator %s)",
    async (userId) => {
      expect(await isComicProjectHidden(project({ userId }), { id: 3 })).toBe(false);
      expect(await isComicProjectHidden(project({ userId }), undefined)).toBe(false);
    }
  );

  it.each(held)('is still shown to its owner and a moderator when %s', async (_, over) => {
    const p = project(over);
    expect(await isComicProjectHidden(p, { id: p.userId as number })).toBe(false);
    expect(await isComicProjectHidden(p, moderator)).toBe(false);
  });

  it('is hidden from everyone once deleted', async () => {
    const deleted = project({ status: 'Deleted' });
    for (const viewer of [reader, owner, moderator])
      expect(await isComicProjectHidden(deleted, viewer)).toBe(true);
  });
});

describe('a panel', () => {
  const clean = { tosViolation: false, needsReview: null, ingestion: 'Scanned' };
  it.each([
    ['with no image yet', null, true],
    ['removed for ToS', { ...clean, tosViolation: true }, true],
    ['in review', { ...clean, needsReview: 'poi' }, true],
    ['not yet scanned', { ...clean, ingestion: 'Pending' }, true],
    ['with a clean image', clean, false],
  ])('%s holds its chapter back: %s', (_, image, tainted) => {
    expect(isPanelTainted({ image })).toBe(tainted);
  });
});
