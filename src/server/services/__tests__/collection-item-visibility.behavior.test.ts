import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import type * as ModelVisibility from '~/server/services/model-visibility.service';

/**
 * `assertCollectionItemsVisibleToViewer` for posts, articles, models and 3D models, against two
 * in-process Postgres databases: `replica` behind dbRead and `primary` behind dbWrite.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { getCached, hiddenModels } = vi.hoisted(() => ({
  getCached: vi.fn(async (..._a: unknown[]): Promise<{ id: number; username: string }[]> => []),
  hiddenModels: vi.fn(async (..._a: unknown[]) => new Set<number>()),
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => {
  const actual = await importOriginal<typeof UserPreferences>();
  return { ...actual, BlockedByUsers: { ...actual.BlockedByUsers, getCached } };
});
vi.mock('~/server/services/model-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVisibility>()),
  getHiddenModelIds: hiddenModels,
}));

import { assertCollectionItemsVisibleToViewer } from '~/server/services/collection-item-visibility';

const OWNER = 10;
const VIEWER = 20;

const SCHEMA = `
  CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp, availability text DEFAULT 'Public');
  CREATE TABLE "Article" (
    id int PRIMARY KEY, "userId" int NOT NULL, status text DEFAULT 'Published', "publishedAt" timestamp DEFAULT now(),
    availability text DEFAULT 'Public', ingestion text DEFAULT 'Scanned'
  );
  CREATE TABLE "Model" (
    id int PRIMARY KEY, "userId" int NOT NULL, status text DEFAULT 'Published', "deletedAt" timestamp,
    availability text DEFAULT 'Public', mode text
  );
  CREATE TABLE "Model3D" (
    id int PRIMARY KEY, "userId" int NOT NULL, status text DEFAULT 'Published', "deletedAt" timestamp,
    availability text DEFAULT 'Public'
  );
`;
const ROWS = `
  INSERT INTO "Post" (id, "userId", "publishedAt", availability) VALUES
    (1, ${OWNER}, now() - interval '1 day', 'Public'),
    (2, ${OWNER}, NULL, 'Public'),
    (3, ${OWNER}, now() - interval '1 day', 'Private'),
    (4, ${OWNER}, now() + interval '1 day', 'Public');
  INSERT INTO "Article" (id, "userId", status, availability, ingestion) VALUES
    (1, ${OWNER}, 'Published', 'Public', 'Scanned'),
    (2, ${OWNER}, 'Draft', 'Public', 'Scanned'),
    (3, ${OWNER}, 'Published', 'Private', 'Scanned'),
    (4, ${OWNER}, 'Published', 'Public', 'Pending');
  INSERT INTO "Model" (id, "userId", status, "deletedAt", availability, mode) VALUES
    (1, ${OWNER}, 'Published', NULL, 'Public', NULL),
    (2, ${OWNER}, 'Draft', NULL, 'Public', NULL),
    (3, ${OWNER}, 'Published', NULL, 'Private', NULL),
    (4, ${OWNER}, 'Published', now(), 'Public', NULL),
    (5, ${OWNER}, 'Published', NULL, 'Public', 'TakenDown'),
    (6, ${OWNER}, 'Published', NULL, 'Public', 'Archived');
  INSERT INTO "Model3D" (id, "userId", status, "deletedAt", availability) VALUES
    (1, ${OWNER}, 'Published', NULL, 'Public'),
    (2, ${OWNER}, 'Draft', NULL, 'Public'),
    (3, ${OWNER}, 'Published', NULL, 'Private'),
    (4, ${OWNER}, 'Published', now(), 'Public');
`;

let replica: PGlite;
let primary: PGlite;

beforeAll(async () => {
  replica = new PGlite();
  primary = new PGlite();
  await Promise.all([replica.exec(SCHEMA), primary.exec(SCHEMA)]);
  const replicaRaw = pgliteRaw(replica);
  const primaryRaw = pgliteRaw(primary);
  dbMock.dbRead.$queryRaw.mockImplementation(((s: TemplateStringsArray, ...v: unknown[]) =>
    replicaRaw.queryRaw(s, ...v)) as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(((s: TemplateStringsArray, ...v: unknown[]) =>
    primaryRaw.queryRaw(s, ...v)) as never);
});

afterAll(async () => {
  await Promise.all([replica.close(), primary.close()]);
});

beforeEach(async () => {
  const reset = `TRUNCATE "Post", "Article", "Model", "Model3D"; ${ROWS}`;
  await Promise.all([replica.exec(reset), primary.exec(reset)]);
  getCached.mockReset().mockResolvedValue([]);
  hiddenModels.mockReset().mockResolvedValue(new Set());
});

type Key = 'postId' | 'articleId' | 'modelId' | 'model3dId';
const check = (itemKey: Key, id: number, viewer: { userId?: number; isModerator?: boolean } = {}) =>
  assertCollectionItemsVisibleToViewer({ itemKey, ids: [id], ...viewer });
const refused = { code: 'NOT_FOUND' };

describe.each([
  [
    'postId',
    [
      ['a draft', 2],
      ['a Private post', 3],
      ['a scheduled post', 4],
    ],
  ],
  [
    'articleId',
    [
      ['a draft', 2],
      ['a Private article', 3],
      ['an unscanned article', 4],
    ],
  ],
  [
    'modelId',
    [
      ['a draft', 2],
      ['a Private model', 3],
      ['a deleted model', 4],
      ['a taken-down model', 5],
    ],
  ],
  [
    'model3dId',
    [
      ['a draft', 2],
      ['a Private 3D model', 3],
      ['a deleted 3D model', 4],
    ],
  ],
] as [Key, [string, number][]][])('%s', (itemKey, hiddenCases) => {
  it('accepts a published, public item from a stranger (control)', async () => {
    await expect(check(itemKey, 1, { userId: VIEWER })).resolves.toBeUndefined();
    await expect(check(itemKey, 1)).resolves.toBeUndefined();
  });

  it.each(hiddenCases)('refuses %s to a stranger', async (_, id) => {
    await expect(check(itemKey, id, { userId: VIEWER })).rejects.toMatchObject(refused);
    await expect(check(itemKey, id)).rejects.toMatchObject(refused);
  });

  it.each(hiddenCases)('accepts %s from its owner', async (_, id) => {
    await expect(check(itemKey, id, { userId: OWNER })).resolves.toBeUndefined();
  });

  it.each(hiddenCases)('accepts %s from staff', async (_, id) => {
    await expect(
      check(itemKey, id, { userId: VIEWER, isModerator: true })
    ).resolves.toBeUndefined();
  });

  it('refuses an id that does not exist, even for staff', async () => {
    await expect(check(itemKey, 999, { userId: VIEWER, isModerator: true })).rejects.toMatchObject(
      refused
    );
  });

  it('refuses an item whose owner blocked the viewer', async () => {
    getCached.mockResolvedValue([{ id: OWNER, username: 'owner' }]);
    await expect(check(itemKey, 1, { userId: VIEWER })).rejects.toMatchObject(refused);
  });
});

describe('a batch', () => {
  it('refuses the whole batch when any item is hidden', async () => {
    await expect(
      assertCollectionItemsVisibleToViewer({ itemKey: 'postId', ids: [1, 2], userId: VIEWER })
    ).rejects.toMatchObject(refused);
  });

  it('accepts a batch split across the replica and the primary', async () => {
    await primary.exec(`INSERT INTO "Article" (id, "userId") VALUES (9, ${OWNER});`);
    await expect(
      assertCollectionItemsVisibleToViewer({ itemKey: 'articleId', ids: [1, 9], userId: VIEWER })
    ).resolves.toBeUndefined();
  });
});

describe('block list', () => {
  beforeEach(() => getCached.mockResolvedValue([{ id: OWNER, username: 'owner' }]));

  it("does not apply to the item's owner", async () => {
    await expect(check('postId', 1, { userId: OWNER })).resolves.toBeUndefined();
  });

  it('does not apply to staff', async () => {
    await expect(
      check('postId', 1, { userId: VIEWER, isModerator: true })
    ).resolves.toBeUndefined();
  });
});

describe('across databases', () => {
  it('accepts a post the replica still shows as a draft, once the primary has the publish', async () => {
    await replica.exec(`UPDATE "Post" SET "publishedAt" = NULL WHERE id = 1;`);
    await expect(check('postId', 1, { userId: VIEWER })).resolves.toBeUndefined();
  });

  it('accepts an item only the primary has yet', async () => {
    await primary.exec(`INSERT INTO "Article" (id, "userId") VALUES (9, ${OWNER});`);
    await expect(check('articleId', 9, { userId: VIEWER })).resolves.toBeUndefined();
  });

  it('applies the same rule on the primary', async () => {
    await primary.exec(`INSERT INTO "Model" (id, "userId", status) VALUES (9, ${OWNER}, 'Draft');`);
    await expect(check('modelId', 9, { userId: VIEWER })).rejects.toMatchObject(refused);
  });
});

describe('models with restricted visibility', () => {
  it('refuses a model the viewer may not see under the model rule', async () => {
    hiddenModels.mockImplementation(async (ids: unknown, viewer: unknown) =>
      JSON.stringify([ids, viewer]) === JSON.stringify([[1], { id: VIEWER }])
        ? new Set([1])
        : new Set()
    );
    await expect(check('modelId', 1, { userId: VIEWER })).rejects.toMatchObject(refused);
  });

  it('leaves that rule to staff', async () => {
    hiddenModels.mockResolvedValue(new Set([1]));
    await expect(
      check('modelId', 1, { userId: VIEWER, isModerator: true })
    ).resolves.toBeUndefined();
  });

  it('keeps an archived model addable', async () => {
    await expect(check('modelId', 6, { userId: VIEWER })).resolves.toBeUndefined();
  });
});
