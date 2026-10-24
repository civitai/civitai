import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as TesterSegment from '~/server/flipt/tester-segment';
import { isFliptPublic } from '~/server/flipt/tester-segment';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
  getCreatorScoreUnlocks,
} from '~/server/services/creator-score-unlocks.service';
import { getServiceSellEligibility } from '~/server/services/creator-service.service';

vi.mock('~/server/flipt/tester-segment', async (importOriginal) => ({
  ...(await importOriginal<typeof TesterSegment>()),
  isFliptPublic: vi.fn(),
}));

const SERVICES = 'creator-services';
const keys = (unlocks: { key: string }[]) => unlocks.map((u) => u.key);

beforeEach(() => {
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null as never);
  vi.mocked(isFliptPublic).mockReset();
});

// Decision (Creator Services P1): the services unlock is kept out of the registry, server-side,
// until the `creator-services` flag is on for everyone. The same list feeds the nightly score job's
// tier-reached notifications, which have no viewer to check a per-user flag against, so a UI-only
// hide would announce a dark feature to every account crossing Beacon. Don't move this check into
// the Journey component.
describe('services unlock while creatorServices is dark', () => {
  it('is absent from the live list the tier-notify job reads when the flag is off', async () => {
    vi.mocked(isFliptPublic).mockResolvedValue(false);
    expect(keys(await getCreatorScoreUnlocks())).not.toContain(SERVICES);
    expect(isFliptPublic).toHaveBeenCalledWith(SERVICES);
  });

  it('appears in that list once the flag is on for everyone', async () => {
    vi.mocked(isFliptPublic).mockResolvedValue(true);
    expect(keys(await getCreatorScoreUnlocks())).toContain(SERVICES);
  });

  it('stays absent when the flag cannot be read', async () => {
    vi.mocked(isFliptPublic).mockRejectedValue(new Error('flipt down'));
    expect(keys(await getCreatorScoreUnlocks())).not.toContain(SERVICES);
  });

  it("is absent from the job's compiled fallback list", () => {
    expect(keys(buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs))).not.toContain(
      SERVICES
    );
  });
});

describe('services unlock threshold', () => {
  const unlock = buildCreatorScoreUnlocks({
    ...compiledCreatorScoreUnlockInputs,
    servicesEnabled: true,
  }).find((u) => u.key === SERVICES);

  const canSell = async (meta: unknown) => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      meta,
      bannedAt: null,
      muted: false,
      deletedAt: null,
    } as never);
    dbMock.dbRead.userStrike.aggregate.mockResolvedValue({ _sum: { points: 0 } } as never);
    return (await getServiceSellEligibility(1)).canSell;
  };

  it('flips the sell gate at the registry threshold', async () => {
    if (!unlock) throw new Error('no creator-services registry entry');
    expect(await canSell({ scores: { total: unlock.minScore - 1 } })).toBe(false);
    expect(await canSell({ scores: { total: unlock.minScore } })).toBe(true);
  });

  // Same number the Creator Program compares, so "same rung as the Creator Program" holds.
  it('compares the aggregate score, as the registry states', async () => {
    if (!unlock) throw new Error('no creator-services registry entry');
    expect(unlock.scoreKind).toBe('aggregate');
    expect(await canSell({ scores: { total: 0, models: unlock.minScore } })).toBe(true);
  });
});
