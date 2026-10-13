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
  it('marks and locks nsfw on a bounty whose text scans R or above, then applies the floor', async () => {
    await applyBountyNsfwTextScan(args(NsfwLevel.R));
    const sql = flipSql();
    expect(sql.replace(/\s+/g, ' ')).toContain(
      `"lockedProperties" = ARRAY( SELECT DISTINCT unnest(COALESCE(b."lockedProperties", ARRAY[]::text[]) || ARRAY['nsfw']::text[]) )`
    );
    expect(sql).toContain('b.nsfw = FALSE');
    expect(sql).toContain(`NOT ('nsfw' = ANY(COALESCE(b."lockedProperties", ARRAY[]::text[])))`);
    expect(sql).toContain(`b."moderatorNsfwLevel" IS NULL`);
    expect(sql).toContain(`'textScanNsfw'`);
    // details can hold JSON null, and `null || object` is null.
    expect(sql).toContain(`jsonb_typeof(b.details) = 'object'`);
    expect(applyRatingFloor).toHaveBeenCalledWith('Bounty', args(NsfwLevel.R));
    expect(dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(applyRatingFloor).mock.invocationCallOrder[0]
    );
  });

  // The owner may have declared nsfw, then unticked it: the declared level the scan compared
  // against can still hold every NSFW bit, so the verdict reads as "not raised".
  it('marks and locks nsfw on an R+ verdict that did not count as a raise', async () => {
    await applyBountyNsfwTextScan(args(NsfwLevel.X, false));
    expect(flipSql()).toContain(`ARRAY['nsfw']::text[]`);
  });

  it('leaves nsfw alone below R, but still applies the floor', async () => {
    const a = args(NsfwLevel.PG13);
    await applyBountyNsfwTextScan(a);
    expect(flipSql()).toBeUndefined();
    expect(applyRatingFloor).toHaveBeenCalledWith('Bounty', a);
  });
});
