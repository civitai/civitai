import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';
import type * as SearchIndex from '~/server/search-index';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ScamScanQueue from '~/server/services/text-scan/scam-scan-queue';

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  enqueueImageIngestion: vi.fn(async () => undefined),
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  usersSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/text-scan/scam-scan-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof ScamScanQueue>()),
  queueScamScan: vi.fn(),
}));

import { addToShowcaseSection } from '~/server/services/user-profile.service';
import type { ShowcaseSectionSchema } from '~/server/schema/user-profile.schema';

const OWNER_ID = 100;
const STRANGER_ID = 200;
const OWN_IMAGE = 21;
const OWN_UNSHOWABLE_IMAGE = 23;
const STRANGER_IMAGE = 22;

const db = dbMock.dbWrite;

// Mirrors the queries' `userId` filter: only the queried user's rows return. The unshowable image is
// the owner's but fails the renderable filter, which the fake applies when the query carries it.
const images: Record<number, { userId: number; showable: boolean }> = {
  [OWN_IMAGE]: { userId: OWNER_ID, showable: true },
  [OWN_UNSHOWABLE_IMAGE]: { userId: OWNER_ID, showable: false },
  [STRANGER_IMAGE]: { userId: STRANGER_ID, showable: true },
};
type ImageWhere = { id: number | { in: number[] }; userId: number; post?: unknown };
const matches = (id: number, where: ImageWhere) =>
  images[id]?.userId === where.userId && (!where.post || images[id].showable);
const ids = (where: ImageWhere) => (typeof where.id === 'number' ? [where.id] : where.id.in);

const section = (
  items: number[],
  id = 's-img',
  type: ShowcaseSectionSchema['type'] = 'Image'
): ShowcaseSectionSchema => ({ id, type, title: 'Mine', items });

const store = (showcaseSections: ShowcaseSectionSchema[]) => {
  db.userProfile.findUnique.mockResolvedValue({ showcaseSections } as never);
  db.userProfile.upsert.mockResolvedValue({ showcaseSections } as never);
};
const saved = () =>
  (db.userProfile.updateMany.mock.calls.at(-1)?.[0] as { data: { showcaseSections: unknown } }).data
    .showcaseSections;

const add = (entityId: number, sectionId = 's-img') =>
  addToShowcaseSection({ userId: OWNER_ID, sectionId, entityType: 'Image', entityId });

beforeEach(() => {
  vi.clearAllMocks();
  db.image.findFirst.mockImplementation((async ({ where }: { where: ImageWhere }) =>
    ids(where).some((id) => matches(id, where)) ? { id: ids(where)[0] } : null) as never);
  db.image.findMany.mockImplementation((async ({ where }: { where: ImageWhere }) =>
    ids(where)
      .filter((id) => matches(id, where))
      .map((id) => ({ id }))) as never);
  db.userProfile.updateMany.mockResolvedValue({ count: 1 } as never);
  store([]);
});

describe('addToShowcaseSection', () => {
  it('puts the owner’s image first in the named section and leaves the others alone', async () => {
    const other = section([1], 's-model', 'Model');
    store([other, section([5]), section([6], 's-img-2')]);

    await expect(add(OWN_IMAGE)).resolves.toMatchObject({ added: true });

    expect(saved()).toEqual([other, section([OWN_IMAGE, 5]), section([6], 's-img-2')]);
  });

  it('refuses another user’s image and writes nothing', async () => {
    store([section([])]);
    await expect(add(STRANGER_IMAGE)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });

  it('refuses the owner’s image when it could not be shown, and writes nothing', async () => {
    store([section([])]);
    await expect(add(OWN_UNSHOWABLE_IMAGE)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });

  it('asks for a published, reviewed, unblocked image', async () => {
    store([section([])]);
    await add(OWN_IMAGE);
    expect(db.image.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: OWN_IMAGE,
          userId: OWNER_ID,
          tosViolation: false,
          needsReview: null,
          post: { publishedAt: { lte: expect.any(Date) } },
          ingestion: { notIn: ['Blocked', 'NotFound'] },
        }),
      })
    );
  });

  it('is a no-op for an image already in the section', async () => {
    store([section([OWN_IMAGE])]);
    await expect(add(OWN_IMAGE)).resolves.toMatchObject({ added: false });
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a full section instead of dropping an item', async () => {
    const full = Array.from({ length: 32 }, (_, i) => 1000 + i);
    store([section(full)]);
    await expect(add(OWN_IMAGE)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['a section that does not exist', [section([])], 'nope'],
    ['a Models section', [section([], 's-model', 'Model')], 's-model'],
  ])('refuses %s', async (_name, sections, sectionId) => {
    store(sections);
    await expect(add(OWN_IMAGE, sectionId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });

  it('reads only the caller’s own profile', async () => {
    store([section([])]);
    await add(OWN_IMAGE);
    expect(db.userProfile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: OWNER_ID } })
    );
    expect(db.userProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: OWNER_ID }) })
    );
  });

  it('saves only over the sections it read, and refuses if they changed meanwhile', async () => {
    const read = [section([5])];
    store(read);
    db.userProfile.updateMany.mockResolvedValue({ count: 0 } as never);

    await expect(add(OWN_IMAGE)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.userProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: OWNER_ID, showcaseSections: { equals: read } },
      })
    );
  });
});
