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

// Models and articles: each refused row differs from the servable one by one field, so a refusal
// can only come from that field. The fake evaluates the service's `where` like SQL (a NULL never
// matches `not`) and throws on a filter it doesn't know, so a new clause can't pass unread.
type Where = Record<string, unknown>;
const holds = (value: unknown, cond: unknown): boolean => {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) return value === cond;
  return Object.entries(cond).every(([op, arg]) => {
    if (op === 'not') return value !== null && value !== arg;
    if (op === 'in') return (arg as unknown[]).includes(value);
    if (op === 'notIn') return value !== null && !(arg as unknown[]).includes(value);
    if (op === 'lte') return value instanceof Date && value <= (arg as Date);
    throw new Error(`fake db: unsupported filter ${op}`);
  });
};
const matchesWhere = (row: Where, where: Where): boolean =>
  Object.entries(where).every(([field, cond]) => {
    if (field === 'OR') return (cond as Where[]).some((w) => matchesWhere(row, w));
    if (!(field in row)) throw new Error(`fake db: row has no ${field}`);
    return holds(row[field], cond);
  });

const DAY = 24 * 60 * 60 * 1000;
const servableModel = {
  id: 0,
  userId: OWNER_ID,
  status: 'Published',
  deletedAt: null as Date | null,
  tosViolation: false,
  availability: 'Public',
  mode: null as string | null,
};
const modelVariants = {
  servable: {},
  archived: { mode: 'Archived' },
  unsearchable: { availability: 'Unsearchable' },
  stranger: { userId: STRANGER_ID },
  draft: { status: 'Draft' },
  unpublished: { status: 'Unpublished' },
  unpublishedViolation: { status: 'UnpublishedViolation' },
  scheduled: { status: 'Scheduled' },
  deleted: { deletedAt: new Date(Date.now() - DAY) },
  tosViolation: { tosViolation: true },
  private: { availability: 'Private' },
  takenDown: { mode: 'TakenDown' },
} as const;
const servableArticle = {
  id: 0,
  userId: OWNER_ID,
  status: 'Published',
  publishedAt: new Date(Date.now() - DAY) as Date | null,
  tosViolation: false,
  ingestion: 'Scanned',
  availability: 'Public',
};
const articleVariants = {
  servable: {},
  pending: { ingestion: 'Pending' },
  rescan: { ingestion: 'Rescan' },
  stranger: { userId: STRANGER_ID },
  draft: { status: 'Draft' },
  unpublished: { status: 'Unpublished' },
  unpublishedViolation: { status: 'UnpublishedViolation' },
  scheduled: { publishedAt: new Date(Date.now() + DAY) },
  neverPublished: { publishedAt: null },
  tosViolation: { tosViolation: true },
  blocked: { ingestion: 'Blocked' },
  private: { availability: 'Private' },
} as const;
const rowsOf = <T extends object>(base: T, variants: Record<string, object>, from: number) => {
  const ids = {} as Record<string, number>;
  const rows: Record<number, Where> = {};
  Object.entries(variants).forEach(([name, patch], i) => {
    ids[name] = from + i;
    rows[from + i] = { ...base, ...patch, id: from + i };
  });
  return { ids, rows };
};
const { ids: MODEL, rows: models } = rowsOf(servableModel, modelVariants, 500);
const { ids: ARTICLE, rows: articles } = rowsOf(servableArticle, articleVariants, 700);

const addAs = (entityType: 'Model' | 'Article', entityId: number, sectionId: string) =>
  addToShowcaseSection({ userId: OWNER_ID, sectionId, entityType, entityId });

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
  for (const [delegate, rows] of [
    [db.model, models],
    [db.article, articles],
  ] as const) {
    delegate.findFirst.mockImplementation((async ({ where }: { where: Where }) => {
      const id = where.id as number;
      return rows[id] && matchesWhere(rows[id], where) ? { id } : null;
    }) as never);
    delegate.findMany.mockImplementation((async ({ where }: { where: Where }) =>
      ((where.id as { in: number[] }).in ?? [])
        .filter((id) => rows[id] && matchesWhere(rows[id], where))
        .map((id) => ({ id }))) as never);
  }
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

describe('addToShowcaseSection — models', () => {
  const models_ = () => section([], 's-model', 'Model');

  it.each(['servable', 'archived', 'unsearchable'] as const)(
    'puts the owner’s %s model first in a Models section',
    async (variant) => {
      store([section([5], 's-model', 'Model'), section([6])]);
      await expect(addAs('Model', MODEL[variant], 's-model')).resolves.toMatchObject({
        added: true,
      });
      expect(saved()).toEqual([section([MODEL[variant], 5], 's-model', 'Model'), section([6])]);
    }
  );

  it.each([
    'stranger',
    'draft',
    'unpublished',
    'unpublishedViolation',
    'scheduled',
    'deleted',
    'tosViolation',
    'private',
    'takenDown',
  ] as const)('refuses a %s model and writes nothing', async (variant) => {
    store([models_()]);
    await expect(addAs('Model', MODEL[variant], 's-model')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Only your own published models can be showcased',
    });
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['an Images section', 's-img'],
    ['an Articles section', 's-art'],
  ])('refuses a model into %s', async (_name, sectionId) => {
    store([section([]), section([], 's-art', 'Article')]);
    await expect(addAs('Model', MODEL.servable, sectionId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });
});

describe('addToShowcaseSection — articles', () => {
  // Pending and Rescan are accepted on purpose: the section's article feed shows other viewers
  // only Scanned articles (pinned in article-showcase-pending.behavior.test.ts), so a fresh
  // article shows up once its scan clears. Refusing them would block adding one just published.
  it.each(['servable', 'pending', 'rescan'] as const)(
    'puts the owner’s %s article first in an Articles section',
    async (variant) => {
      store([section([9], 's-art', 'Article')]);
      await expect(addAs('Article', ARTICLE[variant], 's-art')).resolves.toMatchObject({
        added: true,
      });
      expect(saved()).toEqual([section([ARTICLE[variant], 9], 's-art', 'Article')]);
    }
  );

  it.each([
    'stranger',
    'draft',
    'unpublished',
    'unpublishedViolation',
    'scheduled',
    'neverPublished',
    'tosViolation',
    'blocked',
    'private',
  ] as const)('refuses a %s article and writes nothing', async (variant) => {
    store([section([], 's-art', 'Article')]);
    await expect(addAs('Article', ARTICLE[variant], 's-art')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Only your own published articles can be showcased',
    });
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an article into a Models section', async () => {
    store([section([], 's-model', 'Model')]);
    await expect(addAs('Article', ARTICLE.servable, 's-model')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });
});
