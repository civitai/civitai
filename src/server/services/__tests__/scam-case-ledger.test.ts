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
  restoreScamCases,
  lastModeratorUnmuteAt,
  linkScamStrike,
  recordScamCleanup,
  scamTextSeenBefore,
  scamVerdictActioned,
  voidScamCaseStrikes,
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
    it('closes Pending cases and system cleanup records opened before the unmute, returning their ids', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 5 }, { id: 8 }]);
      expect(await closeScamCasesOpenedBefore(42, AT)).toEqual([5, 8]);
      const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
      const sql = sqlOf(call);
      expect(sql).toContain(`status = 'Overturned', "resolvedAt" = ?, "resolvedBy" = ?`);
      expect(sql).toContain(`WHERE "userId" = ? AND type = 'scam' AND "createdAt" < ?`);
      expect(sql).toContain(`AND (status = 'Pending' OR (status = 'Upheld' AND "resolvedBy" = ?))`);
      expect(sql).toContain('RETURNING id');
      expect(values(call)).toEqual([AT, -1, 42, AT, -1]);
      expect(restoreScamCase).not.toHaveBeenCalled();
    });

    it('voids the strikes the closed cases issued', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ id: 5 }]).mockResolvedValueOnce([]);
      await closeScamCasesOpenedBefore(42, AT);
      const call = dbMock.dbWrite.$queryRaw.mock.calls[1];
      expect(sqlOf(call)).toContain('UPDATE "UserStrike" s');
      expect(values(call)).toEqual(['Voided', null, expect.any(String), [5], 'Active', 'Scam']);
    });

    it("voids the closed cases' strikes on the transaction it is given", async () => {
      const tx = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ id: 5 }])
          .mockResolvedValueOnce([{ id: 77, userId: 42 }]),
        $executeRaw: vi.fn(async () => 1),
      };
      expect(await closeScamCasesOpenedBefore(42, AT, tx as never)).toEqual([5]);
      expect(sqlOf(tx.$queryRaw.mock.calls[1])).toContain('UPDATE "UserStrike" s');
      expect(tx.$executeRaw).toHaveBeenCalledOnce();
      expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    });

    it('runs on the transaction it is given', async () => {
      const tx = { $queryRaw: vi.fn(async () => []) };
      await closeScamCasesOpenedBefore(42, AT, tx as never);
      expect(tx.$queryRaw).toHaveBeenCalledOnce();
      expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('restoreScamCases', () => {
    it('restores each closed case once', async () => {
      await restoreScamCases(42, [5, 8]);
      expect(restoreScamCase.mock.calls).toEqual([[5], [8]]);
    });

    it('logs a failed restore with its case id and still restores the rest', async () => {
      restoreScamCase.mockRejectedValueOnce(new Error('lock timeout'));
      await restoreScamCases(42, [5, 8]);
      expect(restoreScamCase).toHaveBeenCalledTimes(2);
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'scam-restore-failed',
          type: 'error',
          details: { userRestrictionId: 5, userId: 42 },
        })
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
    expect(sqlOf(call)).toContain(`SET triggers = jsonb_set(triggers, ARRAY[?, ?], ?::jsonb)`);
    expect(sqlOf(call)).toContain(`WHERE id = ? AND triggers -> ?::int ->> 'dedupeKey' = ?`);
    expect(values(call)).toEqual(['2', 'cleanup', JSON.stringify(record), 5, 2, 'wf-1']);
  });

  describe('linkScamStrike', () => {
    it('locks the case row before it writes the link', async () => {
      const tx = {
        $queryRaw: vi.fn(async () => [{ status: 'Pending' }]),
        $executeRaw: vi.fn(async () => 1),
      };
      dbMock.dbWrite.$transaction.mockImplementationOnce(async (cb: (t: unknown) => unknown) =>
        cb(tx)
      );

      expect(await linkScamStrike(5, 2, 'wf-1', 77)).toBe(false);

      const [lock] = tx.$queryRaw.mock.calls;
      expect(sqlOf(lock)).toContain('SELECT status FROM "UserRestriction" WHERE id = ? FOR UPDATE');
      expect(values(lock)).toEqual([5]);
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.$executeRaw.mock.invocationCallOrder[0]
      );
      expect(sqlOf(tx.$executeRaw.mock.calls[0])).toContain('SET triggers = jsonb_set');
    });
  });

  describe('voidScamCaseStrikes', () => {
    it('voids only active strikes named by the cases, on the same account', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 77, userId: 42 }]);
      expect(await voidScamCaseStrikes([5], { voidedBy: 3, reason: 'Overturned' })).toEqual([77]);
      const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
      const sql = sqlOf(call);
      expect(sql).toContain(
        `SET status = ?::"StrikeStatus", "voidedAt" = now(), "voidedBy" = ?::int`
      );
      expect(sql).toContain(`WHERE ur.id = ANY(?::int[]) AND ur.type = 'scam'`);
      expect(sql).toContain(`AND s."userId" = ur."userId" AND s.status = ?::"StrikeStatus"`);
      expect(sql).toContain(`s.id IN ( SELECT (t->>'strikeId')::int`);
      expect(values(call)).toEqual(['Voided', 3, 'Overturned', [5], 'Active', 'Scam']);
    });

    it('also voids a Scam strike no case names, landed after this case and before the next', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
      await voidScamCaseStrikes([5], { voidedBy: 3, reason: 'Overturned' });
      const sql = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0]);
      expect(sql).toContain(`s.reason = ?::"StrikeReason" AND s."issuedBy" IS NULL`);
      expect(sql).toContain(`AND s."createdAt" >= ur."createdAt"`);
      expect(sql).toContain(
        `WHERE o."userId" = s."userId" AND o.type = 'scam' AND (ot->>'strikeId')::int = s.id`
      );
      expect(sql).toContain(
        `later."createdAt" > ur."createdAt" AND later."createdAt" <= s."createdAt"`
      );
    });

    it('clears the review flag on the struck accounts the remaining points no longer justify', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 77, userId: 42 }]);
      await voidScamCaseStrikes([5], { voidedBy: 3, reason: 'Overturned' });
      const call = dbMock.dbWrite.$executeRaw.mock.calls[0];
      expect(sqlOf(call)).toContain(`'{strikeFlaggedForReview}', 'false'::jsonb`);
      expect(sqlOf(call)).toContain(`), 0) < ?`);
      expect(values(call)).toEqual([[42], 'Active', 3]);
    });

    it('touches no account when nothing was voided', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
      await voidScamCaseStrikes([5], { voidedBy: 3, reason: 'Overturned' });
      expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    });

    it('does not query for no cases', async () => {
      expect(await voidScamCaseStrikes([], { voidedBy: null, reason: 'x' })).toEqual([]);
      expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
