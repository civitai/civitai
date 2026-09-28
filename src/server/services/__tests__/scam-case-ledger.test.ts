import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Cleanup from '~/server/services/scam-cleanup.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const { restoreScamCase } = vi.hoisted(() => ({
  restoreScamCase: vi.fn(async () => ({ restored: 0 })),
}));
vi.mock('~/server/services/scam-cleanup.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Cleanup>()),
  restoreScamCase,
}));

const {
  appendScamTrigger,
  closeScamCasesOpenedBefore,
  fileScamCleanupRecord,
  lastModeratorUnmuteAt,
  recordScamCleanup,
  scamTextSeenBefore,
  scamVerdictActioned,
} = await import('~/server/services/scam-case-ledger');

const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ');
const values = (call: unknown[]) => call.slice(1);
const AT = new Date('2026-09-24T12:00:00Z');
const entry = {
  category: 'scam' as const,
  source: 's',
  dedupeKey: 'wf-1',
  reason: 'Fake support',
  time: AT.toISOString(),
};

beforeEach(() => vi.clearAllMocks());

describe('scam case ledger', () => {
  it('finds an actioned verdict by its dedupe key among the user’s scam cases', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    expect(await scamVerdictActioned(42, 'wf-1')).toBe(true);
    const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
    expect(sqlOf(call)).toContain(`WHERE "userId" = ? AND type = 'scam' AND triggers @> ?::jsonb`);
    expect(values(call)).toEqual([42, JSON.stringify([{ dedupeKey: 'wf-1' }])]);

    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    expect(await scamVerdictActioned(42, 'wf-2')).toBe(false);
  });

  it('takes the later of a human unmute activity and a moderator overturn', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ at: AT }]);
    expect(await lastModeratorUnmuteAt(42)).toEqual(AT);
    const sql = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0]);
    expect(sql).toContain('GREATEST(');
    expect(sql).toContain(
      `FROM "ModActivity" WHERE "entityType" = 'user' AND "entityId" = ? AND "userId" > 0 AND activity = ANY(?::text[])`
    );
    expect(sql).toContain(
      `FROM "UserRestriction" WHERE "userId" = ? AND type = 'scam' AND status = 'Overturned' AND "resolvedBy" > 0`
    );
    expect(values(dbMock.dbWrite.$queryRaw.mock.calls[0])).toEqual([
      42,
      ['unmute', 'revokeTimedMute'],
      42,
    ]);

    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ at: null }]);
    expect(await lastModeratorUnmuteAt(42)).toBeNull();
  });

  it('matches previously flagged text by entity and hash, only before the boundary', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    expect(
      await scamTextSeenBefore(42, { entityType: 'User', entityId: 42, textHash: 'h' }, AT)
    ).toBe(false);
    const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
    const sql = sqlOf(call);
    expect(sql).toContain(
      `jsonb_array_elements(CASE WHEN jsonb_typeof(ur.triggers) = 'array' THEN ur.triggers ELSE '[]'::jsonb END) t`
    );
    expect(sql).toContain(`t @> ?::jsonb AND (t->>'time')::timestamptz <= ?`);
    expect(values(call)).toEqual([
      42,
      JSON.stringify({ entityType: 'User', entityId: 42, textHash: 'h' }),
      AT,
    ]);
  });

  describe('closeScamCasesOpenedBefore', () => {
    it('closes only Pending scam cases opened before the unmute, as a system overturn', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 5 }]);
      expect(await closeScamCasesOpenedBefore(42, AT)).toBe(1);
      const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
      const sql = sqlOf(call);
      expect(sql).toContain(`SET status = 'Overturned', "resolvedAt" = ?, "resolvedBy" = ?`);
      expect(sql).toContain(
        `WHERE "userId" = ? AND type = 'scam' AND status = 'Pending' AND "createdAt" < ?`
      );
      expect(sql).toContain('RETURNING id');
      expect(values(call)).toEqual([AT, -1, 42, AT]);
    });

    it('restores the content of exactly the cases it closed', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 5 }, { id: 8 }]);
      await closeScamCasesOpenedBefore(42, AT);
      expect(restoreScamCase.mock.calls).toEqual([[5], [8]]);
    });

    it('restores nothing when nothing was open', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
      expect(await closeScamCasesOpenedBefore(42, AT)).toBe(0);
      expect(restoreScamCase).not.toHaveBeenCalled();
    });

    it('logs a failed restore and still closes the rest', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 5 }, { id: 8 }]);
      restoreScamCase.mockRejectedValueOnce(new Error('lock timeout'));
      expect(await closeScamCasesOpenedBefore(42, AT)).toBe(2);
      expect(restoreScamCase).toHaveBeenCalledTimes(2);
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'scam-restore-failed', type: 'error' })
      );
    });
  });

  it('appends an entry only when its dedupe key is not already there, and returns its index', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ index: 3 }]);
    expect(await appendScamTrigger(5, entry)).toBe(3);
    const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
    const sql = sqlOf(call);
    expect(sql).toContain('SET triggers = triggers || ?::jsonb, "updatedAt" = now()');
    expect(sql).toContain('WHERE id = ? AND NOT triggers @> ?::jsonb');
    expect(sql).toContain('RETURNING (jsonb_array_length(triggers) - 1)::int AS index');
    expect(values(call)).toEqual([
      JSON.stringify([entry]),
      5,
      JSON.stringify([{ dedupeKey: 'wf-1' }]),
    ]);

    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    expect(await appendScamTrigger(5, entry)).toBeNull();
  });

  it('writes the cleanup record into the entry at that index, guarded by its dedupe key', async () => {
    const record = {
      kind: 'comments' as const,
      at: AT.toISOString(),
      count: 1,
      ids: [3],
      truncated: false,
    };
    await recordScamCleanup(5, 2, 'wf-1', record);
    const call = dbMock.dbWrite.$executeRaw.mock.calls[0];
    expect(sqlOf(call)).toContain(
      `SET triggers = jsonb_set(triggers, ARRAY[?, 'cleanup'], ?::jsonb)`
    );
    expect(sqlOf(call)).toContain(`WHERE id = ? AND triggers -> ?::int ->> 'dedupeKey' = ?`);
    expect(values(call)).toEqual(['2', JSON.stringify(record), 5, 2, 'wf-1']);
  });

  describe('fileScamCleanupRecord', () => {
    it('opens an already-resolved system record when the account has none', async () => {
      dbMock.dbWrite.userRestriction.create.mockResolvedValue({ id: 9 });
      expect(await fileScamCleanupRecord(42, entry)).toEqual({
        userRestrictionId: 9,
        index: 0,
        created: true,
      });

      const { where } = dbMock.dbWrite.userRestriction.findFirst.mock.calls[0][0];
      expect(where).toEqual({ userId: 42, type: 'scam', status: 'Upheld', resolvedBy: -1 });
      const { data } = dbMock.dbWrite.userRestriction.create.mock.calls[0][0];
      expect(data).toMatchObject({
        userId: 42,
        type: 'scam',
        status: 'Upheld',
        resolvedBy: -1,
        triggers: [entry],
      });
      expect(data.resolvedAt).toBeInstanceOf(Date);
    });

    it('appends to the existing record instead of opening another', async () => {
      dbMock.dbWrite.userRestriction.findFirst.mockResolvedValue({ id: 9 });
      dbMock.dbWrite.$queryRaw.mockResolvedValue([{ index: 2 }]);
      expect(await fileScamCleanupRecord(42, entry)).toEqual({
        userRestrictionId: 9,
        index: 2,
        created: false,
      });
      expect(dbMock.dbWrite.userRestriction.create).not.toHaveBeenCalled();
    });

    it('returns null when the verdict is already on the record', async () => {
      dbMock.dbWrite.userRestriction.findFirst.mockResolvedValue({ id: 9 });
      dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
      expect(await fileScamCleanupRecord(42, entry)).toBeNull();
    });
  });
});
