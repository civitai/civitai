import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mocks = vi.hoisted(() => ({
  verdict: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('~/server/services/model-sfw-face.service', () => ({
  checkComFaceIntentVerdict: mocks.verdict,
  getOwnTriggerWords: vi.fn(async () => ['tw']),
}));
vi.mock('~/server/services/lock-review.service', () => ({
  resolveLockReviewAppeal: mocks.resolve,
}));

const { processComFaceIntentDisputes } = await import(
  '~/server/services/model-com-face-intent-dispute.service'
);

const { comFaceIntentTextHash } = await import('~/server/services/model-com-face-intent.service');
// The detection was recorded for the listing as it stands, with its trigger words.
const recorded = {
  systemNsfwLock: { source: 'com-face-intent', at: '2026-01-01T00:00:00.000Z' },
  comFaceIntent: {
    detected: true,
    textHash: comFaceIntentTextHash({ name: 'n', description: null, triggerWords: ['tw'] }),
    at: 'x',
  },
};

const dispute = (fields: Record<string, unknown> = {}) => ({
  id: 1,
  modelId: 7,
  userId: 3,
  ownerId: 3,
  attempts: 0,
  name: 'n',
  description: null,
  meta: recorded,
  lockedProperties: ['nsfw'],
  ...fields,
});

/** The `autoReview` outcome each Appeal update wrote, or the attempt count for a retry. */
const appealWrites = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.map((call) => (call as unknown[]).slice(1));

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);
  mocks.resolve.mockResolvedValue({ unlocked: ['nsfw'] });
});

describe('processComFaceIntentDisputes', () => {
  it('approves as the system when the slower pass allows it, and marks nothing for moderators', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([dispute()] as never);
    mocks.verdict.mockResolvedValue({ status: 'allowed', promptId: 9 });

    expect(await processComFaceIntentDisputes()).toMatchObject({ overturned: 1 });
    expect(mocks.verdict).toHaveBeenCalledWith(expect.objectContaining({ thinking: true }));
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ appealId: 1, modelId: 7, approve: true, userId: -1 })
    );
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('leaves a still-detected dispute pending for a moderator, marked so it is not judged again', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([dispute()] as never);
    mocks.verdict.mockResolvedValue({ status: 'detected', reason: 'r' });

    expect(await processComFaceIntentDisputes()).toMatchObject({ upheld: 1 });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(appealWrites()).toEqual([['upheld', 1]]);
  });

  it('never approves when the listing changed since the detection; a moderator rules instead', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      dispute({ name: 'edited for the dispute' }),
    ] as never);
    mocks.verdict.mockResolvedValue({ status: 'allowed' });

    expect(await processComFaceIntentDisputes()).toMatchObject({ 'needs-moderator': 1 });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(appealWrites()).toEqual([['needs-moderator', 1]]);
  });

  it('never approves once a moderator has ruled on the lock since it was set', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([dispute()] as never);
    mocks.verdict.mockResolvedValue({ status: 'allowed' });
    dbMock.dbWrite.modActivity.findFirst.mockResolvedValueOnce({ id: 1 } as never);

    expect(await processComFaceIntentDisputes()).toMatchObject({ 'needs-moderator': 1 });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('hands an allowed dispute to a moderator when the approval is refused', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([dispute()] as never);
    mocks.verdict.mockResolvedValue({ status: 'allowed' });
    mocks.resolve.mockRejectedValue(new Error('held'));

    expect(await processComFaceIntentDisputes()).toMatchObject({ 'needs-moderator': 1 });
    expect(appealWrites()).toEqual([['needs-moderator', 1]]);
  });

  it('never approves for someone who no longer owns the model', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([dispute({ ownerId: 4 })] as never);

    expect(await processComFaceIntentDisputes()).toMatchObject({ 'needs-moderator': 1 });
    expect(mocks.verdict).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('retries a missing verdict, then gives it to a moderator on the third', async () => {
    mocks.verdict.mockResolvedValue({ status: 'unavailable' });
    dbMock.dbWrite.$queryRaw.mockResolvedValue([dispute({ attempts: 1 })] as never);
    expect(await processComFaceIntentDisputes()).toMatchObject({ retry: 1 });
    expect(appealWrites()).toEqual([[2, 1]]);

    vi.clearAllMocks();
    dbMock.dbWrite.$queryRaw.mockResolvedValue([dispute({ attempts: 2 })] as never);
    expect(await processComFaceIntentDisputes()).toMatchObject({ unavailable: 1 });
    expect(appealWrites()).toEqual([['unavailable', 1]]);
  });
});
