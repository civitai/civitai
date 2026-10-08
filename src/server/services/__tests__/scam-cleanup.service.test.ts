import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  restoreScamCase,
  runScamCleanup,
  SCAM_CLEANUP_MAX_RECORDED_IDS,
} from '~/server/services/scam-cleanup.service';

const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');
const values = (call: unknown[]) => call.slice(1);

beforeEach(() => vi.clearAllMocks());

describe('runScamCleanup', () => {
  it('does nothing for none', async () => {
    expect(await runScamCleanup('none', 42)).toBeNull();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('soft-deletes the sender’s messages through their chat memberships and records the ids', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 7 }, { id: 9 }]);
    const record = await runScamCleanup('chatMessages', 42);

    const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
    const sql = sqlOf(call);
    expect(sql).toContain('UPDATE "ChatMessage" SET "deletedAt" = ?');
    expect(sql).toContain('"chatId" IN (SELECT "chatId" FROM "ChatMember" WHERE "userId" = ?)');
    expect(sql).toContain('"userId" = ? AND "deletedAt" IS NULL');
    expect(sql).toContain('RETURNING id');
    const [at, memberUserId, senderId] = values(call);
    expect(at).toBeInstanceOf(Date);
    expect([memberUserId, senderId]).toEqual([42, 42]);
    expect(record).toEqual({
      kind: 'chatMessages',
      at: (at as Date).toISOString(),
      count: 2,
      ids: [7, 9],
      truncated: false,
    });
    expect(dbMock.dbWrite.chatMessage.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ['comments', 'UPDATE "Comment" SET hidden = true'],
    ['commentsV2', 'UPDATE "CommentV2" SET hidden = true'],
  ] as const)(
    '%s hides only the author’s visible comments and stamps updatedAt',
    async (kind, head) => {
      dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 3 }]);
      expect(await runScamCleanup(kind, 42)).toMatchObject({ kind, count: 1, ids: [3] });
      const sql = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0]);
      expect(sql).toContain(head);
      expect(sql).toContain('"updatedAt" = ?');
      expect(sql).toContain('"userId" = ? AND hidden IS NOT TRUE');
    }
  );

  it('caps the recorded ids but keeps the true count', async () => {
    const rows = Array.from({ length: SCAM_CLEANUP_MAX_RECORDED_IDS + 5 }, (_, i) => ({
      id: i + 1,
    }));
    dbMock.dbWrite.$queryRaw.mockResolvedValue(rows);
    const record = await runScamCleanup('comments', 42);
    expect(record?.count).toBe(SCAM_CLEANUP_MAX_RECORDED_IDS + 5);
    expect(record?.ids).toHaveLength(SCAM_CLEANUP_MAX_RECORDED_IDS);
    expect(record?.truncated).toBe(true);
  });
});

describe('restoreScamCase', () => {
  const at = '2026-09-24T12:00:00.000Z';

  it('restores chat by the recorded deletedAt, scoped to the sender’s chats', async () => {
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValue({
      userId: 42,
      type: 'scam',
      triggers: [
        {
          dedupeKey: 'wf',
          cleanup: { kind: 'chatMessages', at, count: 2, ids: [7, 9], truncated: false },
        },
      ],
    });
    dbMock.dbWrite.$executeRaw.mockResolvedValue(2);
    expect(await restoreScamCase(5)).toEqual({ restored: 2 });

    const call = dbMock.dbWrite.$executeRaw.mock.calls[0];
    const sql = sqlOf(call);
    expect(sql).toContain('UPDATE "ChatMessage" SET "deletedAt" = NULL');
    expect(sql).toContain('"chatId" IN (SELECT "chatId" FROM "ChatMember" WHERE "userId" = ?)');
    expect(sql).toContain('"deletedAt" = ?');
    expect(values(call)).toEqual([42, 42, new Date(at)]);
  });

  it.each([
    ['comments', 'UPDATE "Comment" SET hidden = false'],
    ['commentsV2', 'UPDATE "CommentV2" SET hidden = false'],
  ] as const)('restores %s by recorded id and owner', async (kind, head) => {
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValue({
      userId: 42,
      type: 'scam',
      triggers: [{ cleanup: { kind, at, count: 2, ids: [3, 4], truncated: false } }],
    });
    dbMock.dbWrite.$executeRaw.mockResolvedValue(2);
    await restoreScamCase(5);
    const call = dbMock.dbWrite.$executeRaw.mock.calls[0];
    expect(sqlOf(call)).toContain(head);
    expect(sqlOf(call)).toContain('id = ANY(?::int[]) AND "userId" = ? AND hidden');
    expect(sqlOf(call)).not.toContain('updatedAt');
    expect(values(call)).toEqual([[3, 4], 42]);
  });

  it('ignores entries without cleanup and rows of another type', async () => {
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValue({
      userId: 42,
      type: 'scam',
      triggers: [
        { dedupeKey: 'a' },
        { cleanup: null },
        { cleanup: { kind: 'comments', at, count: 0, ids: [], truncated: false } },
      ],
    });
    expect(await restoreScamCase(5)).toEqual({ restored: 0 });
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValue({
      userId: 42,
      type: 'generation',
      triggers: [{ cleanup: { kind: 'comments', at, count: 2, ids: [3, 4], truncated: false } }],
    });
    expect(await restoreScamCase(6)).toEqual({ restored: 0 });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});
