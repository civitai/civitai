import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

// Hand-listed: the real module pulls nsfwLevels.service, whose search-index graph builds clients at load.
vi.mock('~/server/services/text-scan/rated-entities', () => ({
  applyRatingFloor: vi.fn(async () => ({ deferredRatingNotice: null })),
}));

const { applyBountyNsfwTextScan } = await import('~/server/services/text-scan/actions/bounty-nsfw');
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
