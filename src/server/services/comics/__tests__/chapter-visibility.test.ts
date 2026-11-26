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

const { isComicProjectHidden, isPanelTainted, withholdRestrictedPanelImages } = await import(
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

describe('an image made with a base model that restricts mature images', () => {
  const R = 4;
  const PG = 1;
  const image = (nsfwLevel: number, modelRestricted = true) => ({
    id: 1,
    url: 'u',
    nsfwLevel,
    modelRestricted,
    userId: OWNER,
    ingestion: 'Scanned',
    blockedFor: null as string | null,
  });
  const servedPanel = (img: ReturnType<typeof image>, viewerId?: number) => {
    const chapter = {
      panels: [{ imageUrl: 'u' as string | null, image: img as typeof img | null }],
    };
    withholdRestrictedPanelImages([chapter], viewerId);
    return chapter.panels[0];
  };

  it('is withheld as a panel from a stranger, a moderator and a signed-out reader', () => {
    for (const viewerId of [reader.id, moderator.id, undefined])
      expect(servedPanel(image(R), viewerId)).toEqual({ imageUrl: null, image: null });
  });

  it('is served to its uploader', () => {
    expect(servedPanel(image(R), OWNER).imageUrl).toBe('u');
  });

  it.each([
    ['SFW with the flag', image(PG)],
    ['mature without the flag', image(R, false)],
    ['XXX without the flag', image(16, false)],
  ])('is served to anyone when %s', (_, img) => {
    expect(servedPanel(img, undefined).imageUrl).toBe('u');
  });

  it('is withheld when rated Blocked, from anyone but its uploader', () => {
    for (const viewerId of [reader.id, undefined])
      expect(servedPanel(image(32, false), viewerId).imageUrl).toBeNull();
    expect(servedPanel(image(32, false), OWNER).imageUrl).toBe('u');
  });
});

describe('a panel whose image is blocked', () => {
  const blocked = (blockedFor: string) => ({
    id: 1,
    url: 'u',
    hash: 'blur-hash' as string | null,
    nsfwLevel: 1,
    modelRestricted: false,
    userId: OWNER,
    ingestion: 'Blocked',
    blockedFor: blockedFor as string | null,
  });

  it.each(['tos', 'moderated'])(
    'keeps its row for its owner with no media or blur hash (%s)',
    (blockedFor) => {
      const panel = {
        imageUrl: 'u' as string | null,
        image: blocked(blockedFor) as ReturnType<typeof blocked> | null,
      };
      withholdRestrictedPanelImages([{ panels: [panel] }], OWNER);
      expect(panel).toMatchObject({ imageUrl: null, image: { id: 1, blockedFor, hash: null } });
    }
  );

  it('keeps the blur hash for a moderator on a session or full-access key', () => {
    const panel = {
      imageUrl: 'u' as string | null,
      image: blocked('tos') as ReturnType<typeof blocked> | null,
    };
    withholdRestrictedPanelImages([{ panels: [panel] }], moderator.id, true);
    expect(panel).toMatchObject({ imageUrl: 'u', image: { hash: 'blur-hash' } });
  });
});
