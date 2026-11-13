import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as Detect from '~/server/services/creator-program-counterparty-review/detect';

const { mockUpsertChat, mockCreateMessage, mockAbuseReport } = vi.hoisted(() => ({
  mockUpsertChat: vi.fn(),
  mockCreateMessage: vi.fn(),
  mockAbuseReport: vi.fn(),
}));
vi.mock('~/server/services/chat.service', () => ({
  upsertChat: mockUpsertChat,
  createMessage: mockCreateMessage,
}));
vi.mock('~/server/services/moderator-app.service', () => ({
  moderatorApp: { abuseReport: mockAbuseReport },
}));
vi.mock('~/server/services/creator-program-counterparty-review/detect', async (importOriginal) => ({
  ...(await importOriginal<typeof Detect>()),
  defaultClickhouse: () => ({
    // One creator over the minimum both ways with one account; no indirect paths.
    $query: async (sql: string) =>
      sql.includes('AS path')
        ? []
        : [{ userId: 11, counterpartyId: 22, received: 30_000, sent: 30_000 }],
  }),
  findProgramMembers: async () => [{ id: 11, username: 'creator' }],
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: () => Promise<unknown>) => ({
    name,
    cron,
    run: () => ({ result: fn(), cancel: () => Promise.resolve() }),
    options: {},
  }),
}));

import {
  creatorProgramCounterpartyReview,
  DEFAULT_COUNTERPARTY_REVIEW_MIN,
  readMinimum,
} from '~/server/jobs/creator-program-counterparty-review';

const { COUNTERPARTY_REVIEW_WARNINGS } = REDIS_SYS_KEYS.CREATOR_PROGRAM;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: new Date('2026-12-01T10:00:00Z'), toFake: ['Date'] });
  return () => vi.useRealTimers();
});

describe('readMinimum', () => {
  // The review runs from the cutover with no ops step; a stored value only overrides the default.
  it('is 25,000 Buzz when nothing valid is stored', () => {
    expect(DEFAULT_COUNTERPARTY_REVIEW_MIN).toBe(25_000);
  });

  it.each([
    [null, DEFAULT_COUNTERPARTY_REVIEW_MIN],
    ['', DEFAULT_COUNTERPARTY_REVIEW_MIN],
    ['abc', DEFAULT_COUNTERPARTY_REVIEW_MIN],
    ['0', DEFAULT_COUNTERPARTY_REVIEW_MIN],
    ['-5', DEFAULT_COUNTERPARTY_REVIEW_MIN],
    ['1234', 1_234],
  ])('reads %j as %j', async (stored, expected) => {
    redisMock.sysRedis.get.mockResolvedValueOnce(stored);

    expect(await readMinimum()).toBe(expected);
    expect(redisMock.sysRedis.get).toHaveBeenCalledWith(
      REDIS_SYS_KEYS.CREATOR_PROGRAM.COUNTERPARTY_REVIEW_MIN
    );
  });
});

describe('creatorProgramCounterpartyReview', () => {
  it('files a creator new to the review on the board and sends them no message', async () => {
    redisMock.sysRedis.get.mockResolvedValue(null);
    redisMock.sysRedis.hGet.mockResolvedValue(null);

    await creatorProgramCounterpartyReview.run().result;

    expect(mockAbuseReport).toHaveBeenCalledTimes(1);
    expect(mockAbuseReport.mock.calls[0][0].findings).toEqual([
      expect.objectContaining({ userId: 11, actioned: false }),
    ]);
    expect(mockUpsertChat).not.toHaveBeenCalled();
    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.hSet).toHaveBeenCalledWith(
      COUNTERPARTY_REVIEW_WARNINGS,
      '11',
      JSON.stringify({ filedAt: '2026-12-01T10:00:00.000Z', counterparties: { '22': 30_000 } })
    );
  });

  // Entries written while the review still messaged creators keep deduping after it stopped.
  it('does not file again a creator recorded under the old shape with no new volume', async () => {
    redisMock.sysRedis.get.mockResolvedValue(null);
    redisMock.sysRedis.hGet.mockImplementation(async (key: string) =>
      key === COUNTERPARTY_REVIEW_WARNINGS
        ? JSON.stringify({
            warnedAt: '2026-10-02T10:00:00.000Z',
            chatId: 5,
            counterparties: { '22': 30_000 },
          })
        : null
    );

    await creatorProgramCounterpartyReview.run().result;

    expect(mockAbuseReport.mock.calls[0][0].findings).toEqual([]);
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
    expect(mockCreateMessage).not.toHaveBeenCalled();
  });
});
