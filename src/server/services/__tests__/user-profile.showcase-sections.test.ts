import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/services/image.service', () => ({
  enqueueImageIngestion: vi.fn(async () => undefined),
}));
vi.mock('~/server/search-index', () => ({
  usersSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
// Any text containing BLOCKED is refused; pins which fields reach the check.
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedUserContent: vi.fn(async (content: unknown) => {
    if ([content].flat().some((text) => typeof text === 'string' && text.includes('BLOCKED')))
      throw Object.assign(new Error('blocked'), { code: 'BAD_REQUEST' });
  }),
}));
const { queueScamScan } = vi.hoisted(() => ({ queueScamScan: vi.fn() }));
vi.mock('~/server/services/text-scan/scam-scan-queue', () => ({ queueScamScan }));

import { setShowcaseSections } from '~/server/services/user-profile.service';
import type { ShowcaseSectionSchema } from '~/server/schema/user-profile.schema';

const OWNER_ID = 100;
const STRANGER_ID = 200;

const db = dbMock.dbWrite;

// Mirrors the `where: { id: { in }, userId }` filter: only rows belonging to the queried user return.
const ownedBy: Record<'image' | 'model' | 'article', Record<number, number>> = {
  model: { 1: OWNER_ID, 2: STRANGER_ID },
  article: { 11: OWNER_ID, 12: STRANGER_ID },
  image: { 21: OWNER_ID, 22: STRANGER_ID },
};
const findOwned =
  (table: keyof typeof ownedBy) =>
  async ({ where }: { where: { id: { in: number[] }; userId: number } }) =>
    where.id.in.filter((id) => ownedBy[table][id] === where.userId).map((id) => ({ id }));

const section = (
  type: ShowcaseSectionSchema['type'],
  items: number[],
  id = `s-${type}`
): ShowcaseSectionSchema => ({ id, type, title: `My ${type}s`, items });

const store = (showcaseSections: ShowcaseSectionSchema[]) =>
  db.userProfile.upsert.mockResolvedValue({ showcaseSections } as never);

beforeEach(() => {
  vi.clearAllMocks();
  db.model.findMany.mockImplementation(findOwned('model') as never);
  db.article.findMany.mockImplementation(findOwned('article') as never);
  db.image.findMany.mockImplementation(findOwned('image') as never);
  db.userProfile.update.mockImplementation((async ({ data }: { data: unknown }) => data) as never);
  store([]);
});

describe('setShowcaseSections', () => {
  it.each([
    ['model', section('Model', [1, 2])],
    ['article', section('Article', [11, 12])],
    ['image', section('Image', [21, 22])],
  ])("refuses another user's %s and writes nothing", async (_name, s) => {
    await expect(setShowcaseSections({ userId: OWNER_ID, sections: [s] })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(db.userProfile.update).not.toHaveBeenCalled();
  });

  it.each([
    ['title', { title: 'BLOCKED' }],
    ['button label', { button: { label: 'BLOCKED', url: '/models' } }],
    ['button link', { button: { label: 'Shop', url: 'https://BLOCKED.example' } }],
  ])('refuses a blocked %s and writes nothing', async (_name, overrides) => {
    await expect(
      setShowcaseSections({
        userId: OWNER_ID,
        sections: [{ ...section('Model', [1]), ...overrides }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.userProfile.upsert).not.toHaveBeenCalled();
    expect(db.userProfile.update).not.toHaveBeenCalled();
  });

  it('queues the profile scam scan once per save', async () => {
    await setShowcaseSections({ userId: OWNER_ID, sections: [section('Model', [1])] });
    expect(queueScamScan).toHaveBeenCalledTimes(1);
    expect(queueScamScan).toHaveBeenCalledWith({ entityType: 'UserProfile', entityId: OWNER_ID });
  });

  it('saves sections of the owner’s own items in the order given', async () => {
    const sections = [section('Article', [11]), section('Model', [1]), section('Image', [21])];
    await expect(setShowcaseSections({ userId: OWNER_ID, sections })).resolves.toEqual(sections);
    expect(db.userProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: OWNER_ID }, data: { showcaseSections: sections } })
    );
  });

  // Same rule as the single Showcase: a model transferred away after it was showcased must not
  // make the whole list unsaveable.
  it('keeps an already-stored item the owner no longer owns', async () => {
    store([section('Model', [2])]);
    const sections = [section('Model', [2, 1])];
    await expect(setShowcaseSections({ userId: OWNER_ID, sections })).resolves.toEqual(sections);
  });

  it('does not let a stored model excuse an article or image with the same id', async () => {
    // Article 2 and Image 2 belong to nobody in the fake, so only the stored Model 2 could excuse them.
    store([section('Model', [2])]);
    for (const type of ['Article', 'Image'] as const)
      await expect(
        setShowcaseSections({
          userId: OWNER_ID,
          sections: [section('Model', [2]), section(type, [2])],
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
