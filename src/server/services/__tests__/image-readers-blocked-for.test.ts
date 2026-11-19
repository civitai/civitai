import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The list readers render `imageBlockedForConditions` into their WHERE. Its behaviour over real rows
 * is pinned in `image-generation-data-visibility.behavior.test.ts`; these pin that each reader
 * actually applies it, for each kind of viewer.
 */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import type { SessionUser } from '~/types/session';
import {
  getImagesByEntity,
  getImagesForModelVersion,
  getImagesForPosts,
} from '~/server/services/image.service';

const VIEWER_ID = 20;
const STOP = new Error('query captured');

/** Runs the reader up to its query and returns that query's text and bound values. */
async function captureQuery(run: () => Promise<unknown>) {
  let captured: Prisma.Sql | undefined;
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
      captured = Array.isArray(first)
        ? Prisma.sql(first as TemplateStringsArray, ...values)
        : (first as Prisma.Sql);
      throw STOP;
    }
  );
  await expect(run()).rejects.toBe(STOP);
  if (!captured) throw new Error('reader never queried');
  return { text: captured.sql.replace(/\s+/g, ' '), values: captured.values };
}

type Viewer = 'anon' | 'other' | 'moderator';
const userFor = (viewer: Viewer) =>
  viewer === 'anon'
    ? undefined
    : ({ id: VIEWER_ID, isModerator: viewer === 'moderator' } as SessionUser);

const READERS: Array<[string, (viewer: Viewer) => Promise<unknown>]> = [
  ['getImagesForPosts', (viewer) => getImagesForPosts({ postIds: [1], user: userFor(viewer) })],
  [
    'getImagesForModelVersion',
    (viewer) => getImagesForModelVersion({ modelVersionIds: [1], user: userFor(viewer) }),
  ],
  [
    'getImagesByEntity',
    (viewer) =>
      getImagesByEntity({
        id: 1,
        type: 'Bounty',
        userId: userFor(viewer)?.id,
        isModerator: viewer === 'moderator',
      }),
  ],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(READERS)('%s applies the blockedFor rule', (_name, read) => {
  it('hides every blocked image from a signed-out viewer', async () => {
    const { text } = await captureQuery(() => read('anon'));
    expect(text).toContain('(i."blockedFor" IS NULL)');
  });

  it("hides other users' blocked images from a signed-in viewer, but not their own", async () => {
    const { text, values } = await captureQuery(() => read('other'));
    expect(text).toContain('(i."blockedFor" IS NULL OR i."userId" = ?)');
    expect(values).toContain(VIEWER_ID);
  });

  it('applies no blockedFor filter for a moderator', async () => {
    const { text } = await captureQuery(() => read('moderator'));
    expect(text).not.toContain('"blockedFor" IS NULL');
  });
});
