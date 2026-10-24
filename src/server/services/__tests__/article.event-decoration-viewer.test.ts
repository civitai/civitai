import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CosmeticService from '~/server/services/cosmetic.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { decorations } = vi.hoisted(() => ({ decorations: vi.fn(async () => ({})) }));
vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticService>()),
  getEventDecorationsForEntity: decorations,
  getCosmeticsForEntity: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCategoryTags: async () => [],
}));

import { ArticleSort } from '~/server/common/enums';
import { getArticles } from '~/server/services/article.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

/**
 * Before launch, event decorations are shown only to a viewer the event's flag is on for, and only
 * when the caller names that viewer (getEventDecorationsForEntity). The session user is NOT that:
 * getArticles also serves cached and REST callers, so only `eventDecorationViewer` reaches it.
 */
const base = { limit: 10, sort: ArticleSort.Newest, period: MetricTimeframe.AllTime };
const viewerPassed = () =>
  (decorations.mock.calls.at(-1) as unknown as [{ viewer?: unknown }])[0].viewer;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.$queryRaw.mockResolvedValue([]);
  dbMock.dbRead.image.findMany.mockResolvedValue([]);
});

describe('getArticles event decorations', () => {
  it('passes the named viewer on', async () => {
    await getArticles({
      ...base,
      include: ['cosmetics'],
      sessionUser: { id: 5 },
      eventDecorationViewer: { id: 5 },
    } as never);
    expect(decorations).toHaveBeenCalledTimes(1);
    expect(viewerPassed()).toEqual({ id: 5 });
  });

  it('treats a caller that names no viewer as signed out, even with a session user', async () => {
    await getArticles({ ...base, include: ['cosmetics'], sessionUser: { id: 5 } } as never);
    expect(decorations).toHaveBeenCalledTimes(1);
    expect(viewerPassed()).toBeUndefined();
  });
});
