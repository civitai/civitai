import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { query: mockQuery } }));

import { userRestrictionRouter } from '../user-restriction.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const caller = () =>
  userRestrictionRouter.createCaller({
    user: { id: 1, isModerator: true, tier: 'free', username: 'mod' },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.userRestriction.findMany.mockResolvedValue([
    { id: 3, userId: 9, triggers: [], createdAt: new Date('2026-01-02T00:00:00Z') },
  ]);
  mockQuery.mockResolvedValue({ json: async () => [] });
});

describe('userRestriction.backfillTriggers — the ClickHouse read', () => {
  it('selects remixOfId, which the rebuilt origin depends on', async () => {
    await caller().backfillTriggers({ userRestrictionId: 3 });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const { query, query_params } = mockQuery.mock.calls[0][0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    const select = query.match(/SELECT([\s\S]*?)FROM prohibitedRequests/)?.[1];
    expect(select?.split(',').map((c) => c.trim())).toEqual([
      'prompt',
      'negativePrompt',
      'source',
      'remixOfId',
      'inputImages',
      'inputVideo',
      'createdDate',
    ]);
    expect(query_params).toMatchObject({ userId: 9 });
  });
});
