import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Eligibility from '~/server/jobs/refresh-featured-collections-eligibility';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/redis.mock';

vi.mock('~/server/jobs/refresh-featured-collections-eligibility', async (importOriginal) => ({
  ...(await importOriginal<typeof Eligibility>()),
  getFeaturedCollectionsState: vi.fn(async () => ({ eligibleIds: [111], checkedAt: new Date() })),
}));

const { runAutoFeatureImages } = await import('~/server/services/auto-feature-images.service');

const CANDIDATE_WINDOW = 7;
const CAP_WINDOW = 30;

const block = { id: 388990, metadata: {} as HomeBlockMetaSchema };

/**
 * Rebuilds the text a `$queryRaw` tagged template would have produced. `Prisma.raw` arrives as a
 * Sql fragment rather than a bound parameter, which is exactly why the interval days land in the
 * query text and can be asserted on here.
 */
const sqlText = (call: unknown[] | undefined) => {
  if (!call) return '';
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  return strings
    .map((chunk, i) => {
      const value = values[i];
      const rendered =
        value && typeof value === 'object' && 'strings' in (value as Record<string, unknown>)
          ? (value as { strings: readonly string[] }).strings.join('')
          : value === undefined
          ? ''
          : String(value);
      return chunk + rendered;
    })
    .join('');
};

const queries = () => dbMock.dbRead.$queryRaw.mock.calls.map((call) => sqlText(call));
const candidateQuery = () => queries().find((q) => q.includes('ImageReaction')) ?? '';
const capCountQuery = () => queries().find((q) => q.includes('split_part')) ?? '';

beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockClear();
  dbMock.dbRead.$queryRaw.mockImplementation(async () => []);
  dbMock.dbRead.homeBlock.findFirst.mockImplementation(async () => block);
  dbMock.dbRead.user.findFirst.mockImplementation(async () => ({ id: 42 }));
  block.metadata = {
    featuredCollections: {
      collectionIds: [111],
      limit: 40,
      rows: 2,
      renderCount: 3,
      nameSnapshots: {},
      writeSnapshots: {},
      autoFeature: {
        collectionId: 107,
        dryRun: true,
        windowDays: CANDIDATE_WINDOW,
        capWindowDays: CAP_WINDOW,
      },
    },
  } as unknown as HomeBlockMetaSchema;
});

// The two windows were one config value. Tuning the repeat cap — the whole point of that value
// living in editable metadata — also moved the candidate-freshness window, so the job quietly
// picked from a different pool than the editor intended. These assert the split by giving the
// two windows DIFFERENT values: recouple them and the interval printed here is the wrong number,
// not a timeout or a silent pass.
describe('auto-feature windows are independent', () => {
  it('counts previous auto-features over capWindowDays', async () => {
    await runAutoFeatureImages();

    expect(capCountQuery()).toContain(`days => ${CAP_WINDOW}`);
    expect(capCountQuery()).not.toContain(`days => ${CANDIDATE_WINDOW}`);
  });

  it('still picks candidates over windowDays', async () => {
    await runAutoFeatureImages();

    expect(candidateQuery()).toContain(`days => ${CANDIDATE_WINDOW}`);
    expect(candidateQuery()).not.toContain(`days => ${CAP_WINDOW}`);
  });

  it('reports both windows so a run says which pool and which cap it used', async () => {
    const result = await runAutoFeatureImages();

    expect(result).toMatchObject({ windowDays: CANDIDATE_WINDOW, capWindowDays: CAP_WINDOW });
  });
});
