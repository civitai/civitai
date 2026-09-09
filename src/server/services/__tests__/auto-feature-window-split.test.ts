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

// Deliberately not prefixes of one another: the assertions match the interval by substring, so
// 70 against 7 would fail spuriously. Wrong in the red direction, but worth not stepping on.
const CANDIDATE_WINDOW = 7;
const CAP_WINDOW = 30;
/** What `capWindowDays` falls back to, and what live config — which has no such key — will use. */
const SCHEMA_DEFAULT = 7;

const block = { id: 388990, metadata: {} as HomeBlockMetaSchema };

const metadata = (autoFeature: Record<string, unknown>) =>
  ({
    featuredCollections: {
      collectionIds: [111],
      limit: 40,
      rows: 2,
      renderCount: 3,
      nameSnapshots: {},
      writeSnapshots: {},
      autoFeature: { collectionId: 107, dryRun: true, ...autoFeature },
    },
  } as unknown as HomeBlockMetaSchema);

/**
 * The queries are built rather than issued inline, so this reads Prisma's own `.sql` off the
 * argument instead of reconstructing text from a tagged template.
 */
const queries = () =>
  dbMock.dbRead.$queryRaw.mock.calls.map((call) => (call[0] as { sql?: string })?.sql ?? '');
const candidateQuery = () => queries().find((q) => q.includes('ImageReaction')) ?? '';
// Identified by exclusion rather than by `split_part`, which the counts query no longer contains:
// the auto-featured marker is parsed in JS now, through the same helper the removal paths use.
const capCountQuery = () =>
  queries().find((q) => !q.includes('ImageReaction') && q.includes('"CollectionItem"')) ?? '';

/**
 * Pins that BOTH queries were issued. Without it the two `.not.toContain` assertions below could
 * never fail on their own — `expect('').not.toContain(…)` passes — and they would be saved only
 * by sitting next to a positive assertion in the same test.
 */
const expectBothQueriesIssued = () => {
  expect(queries()).toHaveLength(2);
  expect(candidateQuery()).not.toBe('');
  expect(capCountQuery()).not.toBe('');
};

beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockClear();
  dbMock.dbRead.$queryRaw.mockImplementation(async () => []);
  dbMock.dbRead.homeBlock.findFirst.mockImplementation(async () => block);
  dbMock.dbRead.user.findFirst.mockImplementation(async () => ({ id: 42 }));
  block.metadata = metadata({ windowDays: CANDIDATE_WINDOW, capWindowDays: CAP_WINDOW });
});

// The two windows were one config value. Tuning the repeat cap — the whole point of that value
// living in editable metadata — also moved the candidate-freshness window, so the job quietly
// picked from a different pool than the editor intended. These assert the split by giving the
// two windows DIFFERENT values: recouple them and the interval printed here is the wrong number,
// not a timeout or a silent pass.
describe('auto-feature windows are independent', () => {
  it('counts previous auto-features over capWindowDays', async () => {
    await runAutoFeatureImages();

    expectBothQueriesIssued();
    expect(capCountQuery()).toContain(`days => ${CAP_WINDOW}`);
    expect(capCountQuery()).not.toContain(`days => ${CANDIDATE_WINDOW}`);
  });

  it('still picks candidates over windowDays', async () => {
    await runAutoFeatureImages();

    expectBothQueriesIssued();
    expect(candidateQuery()).toContain(`days => ${CANDIDATE_WINDOW}`);
    expect(candidateQuery()).not.toContain(`days => ${CAP_WINDOW}`);
  });

  // The path every existing config actually takes. Stored metadata has no `capWindowDays` key, so
  // the schema default is the only branch that runs on deploy — and it is the branch the "nothing
  // changes on deploy" claim rests on. Without this, raising the default to 365 breaks nothing.
  it('falls back to the schema default when config has no capWindowDays', async () => {
    block.metadata = metadata({ windowDays: CANDIDATE_WINDOW });

    await runAutoFeatureImages();

    expectBothQueriesIssued();
    expect(capCountQuery()).toContain(`days => ${SCHEMA_DEFAULT}`);
    expect(candidateQuery()).toContain(`days => ${CANDIDATE_WINDOW}`);
  });

  // Echoes parsed config, so it cannot tell you the windows are wired correctly — it would have
  // passed under the bug this PR fixes. It guards the run summary itself, which is what a run's
  // log shows, and nothing more.
  it('reports both windows in the run summary', async () => {
    const result = await runAutoFeatureImages();

    expect(result).toMatchObject({ windowDays: CANDIDATE_WINDOW, capWindowDays: CAP_WINDOW });
  });
});
