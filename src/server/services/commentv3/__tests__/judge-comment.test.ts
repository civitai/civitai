import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as WriteService from '~/server/services/commentv3/write.service';

const m = vi.hoisted(() => ({
  insert: vi.fn(async () => ({ id: 300 })),
  blocklist: vi.fn(async () => undefined),
  blocked: vi.fn(async () => undefined),
  owners: vi.fn(async () => [9]),
  scan: vi.fn(),
  onCommentCreated: vi.fn(),
}));

vi.mock('~/server/services/commentv3/write.service', async (importOriginal) => ({
  ...(await importOriginal<typeof WriteService>()),
  insertComment: m.insert,
}));
vi.mock('~/server/services/block-check.service', () => ({
  getBlockCheckOwnerIds: m.owners,
  throwIfBlockedByOwners: m.blocked,
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedCommentContent: m.blocklist,
}));
vi.mock('~/server/services/sticker.service', () => ({
  spendStickerUses: vi.fn(async () => new Map()),
  recordStickerUsage: vi.fn(),
}));
vi.mock('~/server/services/text-scan/scam-scan-queue', () => ({ queueScamScan: m.scan }));
vi.mock('~/server/events/points/hooks', () => ({ onCommentCreated: m.onCommentCreated }));

const { writeJudgeComment } = await import('~/server/services/commentv3/comment-write.service');

const JUDGE = 5;
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((async (cb: (tx: unknown) => unknown) =>
    cb({ $queryRawUnsafe: vi.fn(async () => []) })) as never);
});

describe('writeJudgeComment', () => {
  it('writes a new comment on the image after the text and block checks, with no points', async () => {
    await writeJudgeComment({ userId: JUDGE, imageId: 40, content: 'hi' });
    expect(m.blocklist).toHaveBeenCalledWith('hi', { isModerator: false });
    expect(m.blocked).toHaveBeenCalledWith({ userId: JUDGE, ownerIds: [9] });
    expect(m.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: JUDGE, entityType: 'image', entityId: 40, content: 'hi' })
    );
    expect(m.scan).toHaveBeenCalledWith({ entityType: 'CommentV3', entityId: 300 });
    expect(m.onCommentCreated).not.toHaveBeenCalled();
  });

  it('writes nothing when the image owner blocked the judge', async () => {
    m.blocked.mockRejectedValueOnce(new Error('blocked'));
    await expect(writeJudgeComment({ userId: JUDGE, imageId: 40, content: 'hi' })).rejects.toThrow(
      'blocked'
    );
    expect(m.insert).not.toHaveBeenCalled();
  });
});
