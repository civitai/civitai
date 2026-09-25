import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { NsfwLevel } from '~/server/common/enums';

// Hand-listed: the real module pulls nsfwLevels.service, whose search-index graph builds clients at load.
vi.mock('~/server/services/text-scan/rated-entities', () => ({
  applyRatingFloor: vi.fn(async () => ({ deferredRatingNotice: null })),
}));

// Hand-listed: bounty.service pulls search-index and Buzz clients at load.
vi.mock('~/server/services/bounty.service', () => ({ voidBountyForNsfw: vi.fn() }));
// Hand-listed: the real module's graph builds queue clients at load.
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
}));

const { applyBountyNsfwTextScan } = await import('~/server/services/text-scan/actions/bounty-nsfw');
const { voidBountyForNsfw } = await import('~/server/services/bounty.service');
const { createNotification } = await import('~/server/services/notification.service');
const { applyRatingFloor } = await import('~/server/services/text-scan/rated-entities');

const args = (detectedLevel: number, raised = true) => ({
  entityId: 4,
  workflowId: 'wf-9',
  outcome: {
    nsfw: { detectedLevel, declaredLevel: 1, raised, reason: 'r' },
    triggeredLabels: raised ? ['nsfw' as const] : [],
    nsfwLevel: detectedLevel,
  },
  subject: { fields: [], declared: { nsfwLevel: 1 } },
});
const flipSql = () =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .map((c: unknown[]) => (c[0] as readonly string[]).join('?'))
    .find((sql: string) => sql.includes('SET nsfw = TRUE'));

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  loggingMock.logToAxiom.mockResolvedValue(undefined);
  dbMock.dbWrite.bounty.findUnique.mockResolvedValue({
    userId: 5,
    nsfw: false,
    lockedProperties: [],
    buzzType: 'yellow',
    moderatorNsfwLevel: null,
  });
});

describe('applyBountyNsfwTextScan', () => {
  it('marks a bounty the scan raised to R nsfw, then applies the floor', async () => {
    await applyBountyNsfwTextScan(args(NsfwLevel.R));
    const sql = flipSql();
    expect(sql).toContain('b.nsfw = FALSE');
    expect(sql).toContain(`NOT ('nsfw' = ANY(b."lockedProperties"))`);
    expect(sql).toContain(`b."moderatorNsfwLevel" IS NULL`);
    expect(sql).toContain(`'textScanNsfw'`);
    // details can hold JSON null, and `null || object` is null.
    expect(sql).toContain(`jsonb_typeof(b.details) = 'object'`);
    expect(sql).not.toContain('lockedProperties" =');
    expect(applyRatingFloor).toHaveBeenCalledWith('Bounty', args(NsfwLevel.R));
    expect(dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(applyRatingFloor).mock.invocationCallOrder[0]
    );
  });

  it.each([
    ['below R', args(NsfwLevel.PG13)],
    ['not raised', args(NsfwLevel.X, false)],
  ])('leaves nsfw alone when the verdict is %s, but still applies the floor', async (_, a) => {
    await applyBountyNsfwTextScan(a);
    expect(flipSql()).toBeUndefined();
    expect(applyRatingFloor).toHaveBeenCalledWith('Bounty', a);
  });
});

describe('applyBountyNsfwTextScan — green-Buzz bounties', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    userId: 5,
    nsfw: false,
    lockedProperties: ['nsfw'],
    buzzType: 'green',
    moderatorNsfwLevel: null,
    ...over,
  });

  beforeEach(() => {
    dbMock.dbWrite.bounty.findUnique.mockResolvedValue(stored());
    vi.mocked(voidBountyForNsfw).mockResolvedValue({ voided: true, refundedUserIds: [5, 6] });
  });

  it('voids and refunds, tells every benefactor once, and raises the rating silently', async () => {
    await applyBountyNsfwTextScan(args(NsfwLevel.R));
    expect(voidBountyForNsfw).toHaveBeenCalledWith(4);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 5, key: 'bounty-nsfw-cancelled-4', type: 'system-message' })
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 6, key: 'bounty-nsfw-cancelled-4-6' })
    );
    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(flipSql()).toBeUndefined();
    expect(applyRatingFloor).toHaveBeenCalledWith('Bounty', args(NsfwLevel.R), { notify: false });
  });

  it.each(['in-payout', 'no-currency'] as const)(
    'holds a bounty it cannot claim (%s), and says so',
    async (reason) => {
      vi.mocked(voidBountyForNsfw).mockResolvedValue({ voided: false, reason });
      await applyBountyNsfwTextScan(args(NsfwLevel.X));
      expect(createNotification).not.toHaveBeenCalled();
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'bounty-nsfw-escalation-held', bountyId: 4, reason })
      );
    }
  );

  it('is silent on a redelivery after the refund', async () => {
    vi.mocked(voidBountyForNsfw).mockResolvedValue({ voided: false, reason: 'already-refunded' });
    await applyBountyNsfwTextScan(args(NsfwLevel.X));
    expect(createNotification).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('never voids a bounty whose currency is unknown; the floor still rates it', async () => {
    dbMock.dbWrite.bounty.findUnique.mockResolvedValue(stored({ buzzType: null }));
    await applyBountyNsfwTextScan(args(NsfwLevel.R));
    expect(voidBountyForNsfw).not.toHaveBeenCalled();
    expect(flipSql()).toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'bounty-nsfw-green-unknown', bountyId: 4 })
    );
    expect(applyRatingFloor).toHaveBeenCalledWith('Bounty', args(NsfwLevel.R));
  });

  it('leaves a moderator-rated bounty alone', async () => {
    dbMock.dbWrite.bounty.findUnique.mockResolvedValue(stored({ moderatorNsfwLevel: 1 }));
    await applyBountyNsfwTextScan(args(NsfwLevel.X));
    expect(voidBountyForNsfw).not.toHaveBeenCalled();
    expect(applyRatingFloor).toHaveBeenCalledWith('Bounty', args(NsfwLevel.X));
  });

  it('does not void below R', async () => {
    await applyBountyNsfwTextScan(args(NsfwLevel.PG13));
    expect(voidBountyForNsfw).not.toHaveBeenCalled();
  });
});
