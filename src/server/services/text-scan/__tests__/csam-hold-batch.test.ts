import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const mocks = vi.hoisted(() => ({ decide: vi.fn() }));

// Hand-listed: the loop under test never reaches a removal, only the module's imports do.
vi.mock('~/server/services/article.service', () => ({ unpublishArticleById: vi.fn() }));
vi.mock('~/server/services/chat.service', () => ({ deleteChatMessage: vi.fn() }));
vi.mock('~/server/services/comment.service', () => ({ bulkSetCommentTosViolation: vi.fn() }));
vi.mock('~/server/services/commentsv2.service', () => ({ bulkSetCommentV2TosViolation: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({
  toggleBan: vi.fn(),
  clearUserProfileFields: vi.fn(),
}));
vi.mock('~/server/services/strike.service', () => ({ createStrike: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({ unpublishModelById: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ unpublishPostAsModerator: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));
vi.mock('~/server/services/text-scan/actions/csam-hold', () => ({ lockCsamHold: vi.fn() }));

const {
  CSAM_HOLD_BATCH_MAX,
  STALE_HOLD_MESSAGE,
  decideCsamHoldBatch: decideBatch,
  resolveCsamHoldInput,
} = await import('~/server/services/text-scan/csam-hold-decision');
const decideCsamHoldBatch = (args: Omit<Parameters<typeof decideBatch>[0], 'decide'>) =>
  decideBatch({ ...args, decide: mocks.decide });

const actor = { id: 7 };
const tracker = {} as never;

beforeEach(() => {
  mocks.decide.mockReset();
  loggingMock.logToAxiom.mockClear();
});

describe('decideCsamHoldBatch', () => {
  it('decides each hold on its own text hash and reports every result', async () => {
    mocks.decide
      .mockResolvedValueOnce({ status: 'Confirmed', entityType: 'Model', entityId: 1, userId: 9 })
      .mockRejectedValueOnce(new TRPCError({ code: 'CONFLICT', message: STALE_HOLD_MESSAGE }))
      .mockRejectedValueOnce(Object.assign(new Error('db exploded: held text'), { code: 'P2034' }));

    const results = await decideCsamHoldBatch({
      holds: [
        { holdId: 2, textHash: 'a' },
        { holdId: 3, textHash: 'b' },
        { holdId: 4, textHash: 'c' },
      ],
      decision: 'remove',
      note: 'n',
      actor,
      tracker,
    });

    expect(
      mocks.decide.mock.calls.map(([args]) => [args.holdId, args.textHash, args.decision])
    ).toEqual([
      [2, 'a', 'remove'],
      [3, 'b', 'remove'],
      [4, 'c', 'remove'],
    ]);
    expect(results).toEqual([
      { holdId: 2, ok: true, status: 'Confirmed', entityType: 'Model', entityId: 1, userId: 9 },
      { holdId: 3, ok: false, stale: true, error: STALE_HOLD_MESSAGE },
      { holdId: 4, ok: false, stale: false, error: 'Could not apply the decision to this hold.' },
    ]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom.mock.calls[0][0]).toMatchObject({
      holdId: 4,
      errorName: 'Error',
      errorCode: 'P2034',
    });
    expect(JSON.stringify(loggingMock.logToAxiom.mock.calls)).not.toContain('held text');
  });

  it('decides a hold listed twice once', async () => {
    mocks.decide.mockResolvedValue({
      status: 'Dismissed',
      entityType: 'Post',
      entityId: 1,
      userId: 1,
    });
    const results = await decideCsamHoldBatch({
      holds: [
        { holdId: 2, textHash: 'a' },
        { holdId: 2, textHash: 'a' },
      ],
      decision: 'dismiss',
      actor,
      tracker,
    });
    expect(results).toHaveLength(1);
    expect(mocks.decide).toHaveBeenCalledTimes(1);
  });
});

describe('resolveCsamHoldInput', () => {
  const hold = (holdId: number) => ({ holdId, textHash: `h${holdId}` });

  it('keeps the single-hold shape', () => {
    expect(
      resolveCsamHoldInput.safeParse({ holdId: 1, textHash: 'h1', decision: 'remove_ban' }).success
    ).toBe(true);
    expect(resolveCsamHoldInput.safeParse({ holdId: 1, decision: 'remove_ban' }).success).toBe(
      false
    );
  });

  it('accepts a batch of remove or dismiss', () => {
    for (const decision of ['remove', 'dismiss'])
      expect(resolveCsamHoldInput.safeParse({ holds: [hold(1)], decision }).success).toBe(true);
  });

  it.each(['remove_strike', 'remove_ban', 'remove_ban_report'])(
    'refuses %s on a batch',
    (decision) => {
      expect(resolveCsamHoldInput.safeParse({ holds: [hold(1)], decision }).success).toBe(false);
    }
  );

  it('caps a batch', () => {
    const holds = (n: number) => Array.from({ length: n }, (_, i) => hold(i + 1));
    expect(
      resolveCsamHoldInput.safeParse({ holds: holds(CSAM_HOLD_BATCH_MAX), decision: 'remove' })
        .success
    ).toBe(true);
    expect(
      resolveCsamHoldInput.safeParse({ holds: holds(CSAM_HOLD_BATCH_MAX + 1), decision: 'remove' })
        .success
    ).toBe(false);
    expect(resolveCsamHoldInput.safeParse({ holds: [], decision: 'remove' }).success).toBe(false);
  });

  it('needs exactly one of holdId and holds', () => {
    expect(resolveCsamHoldInput.safeParse({ decision: 'remove' }).success).toBe(false);
    expect(
      resolveCsamHoldInput.safeParse({ holdId: 1, holds: [hold(2)], decision: 'remove' }).success
    ).toBe(false);
  });
});
