import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';

/**
 * Model VERSION name moderation.
 *
 * The property that would fail silently is the DIRECTION. The term list decides and the scan
 * only ever overturns, so a callback can lower the flag and nothing downstream of the list can
 * raise it. Reverting that reads as a small refactor and turns XGuard — which returns
 * `suggestive` in the 0.55-0.69 band for strings as contentless as `v1.0` — back into the thing
 * that decides, flagging on its noise floor with no test failing.
 *
 * Beside it: the SYSTEM-OWNED exclusion, which is a trap with no way back out in one direction
 * and a permanently stamped level in the other.
 */

const { entityChangesMock } = vi.hoisted(() => ({ entityChangesMock: vi.fn() }));

vi.mock('~/server/services/text-moderation.service', () => ({ submitTextModeration: vi.fn() }));
vi.mock('~/server/services/nsfwLevels.service', () => ({
  updateModelVersionNsfwLevels: vi.fn(),
  updateModelNsfwLevels: vi.fn(),
}));
vi.mock('~/server/clickhouse/tracker', () => ({
  // A class, not an arrow mock: the adapter constructs this with `new`.
  Tracker: class {
    entityChanges = entityChangesMock;
  },
}));
vi.mock('~/server/services/model-version-name-terms.service', () => ({
  getModelVersionNameTerms: vi.fn(),
  matchModelVersionNameTerms: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));

const { modelVersionModerationAdapter, moderateModelVersionName } = await import(
  '~/server/services/model-version-moderation.adapter'
);
const { updateModelVersionNsfwLevels, updateModelNsfwLevels } = await import(
  '~/server/services/nsfwLevels.service'
);
const { submitTextModeration } = await import('~/server/services/text-moderation.service');
const { getModelVersionNameTerms, matchModelVersionNameTerms } = await import(
  '~/server/services/model-version-name-terms.service'
);
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');

/** A scan that triggered a level label — XGuard agreeing with the term list. */
const agrees = (score = 0.9, label = 'Suggestive') =>
  ({
    triggeredLabels: [label],
    results: [{ label, score, threshold: 0.5, triggered: true }],
  } as never);

/** A scan that triggered nothing — XGuard overturning the term list. */
const overturns = () => ({ triggeredLabels: [], results: [] } as never);

const applyArgs = (output: unknown, triggeredLabels: string[] = []) => ({
  entityId: 7,
  workflowId: 'wf-1',
  blocked: false,
  triggeredLabels,
  output: output as never,
});

/** Every `nsfw` write the adapter issued, with the value it bound. */
const flagWrites = () =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .map((call: unknown[]) => ({
      sql: (call[0] as unknown as readonly string[]).join('?'),
      values: call.slice(1),
    }))
    .filter((c) => c.sql.includes('SET nsfw'))
    .map((c) => ({ sql: c.sql, nsfw: c.values[0] as boolean, versionId: c.values[1] as number }));

const flaggedVersion = (nsfw: boolean, ruling?: { by: number; at: string; nsfw: boolean }) => ({
  id: 7,
  nsfw,
  meta: ruling ? { nsfwDecision: ruling } : {},
  modelId: 3,
  model: { userId: 99 },
});

const RULING = { by: 5, at: '2026-08-27T00:00:00.000Z', nsfw: false };

beforeEach(() => {
  vi.clearAllMocks();
  entityChangesMock.mockResolvedValue(undefined);
  vi.mocked(getModelVersionNameTerms).mockResolvedValue({ triggers: ['sex'] });
  vi.mocked(matchModelVersionNameTerms).mockResolvedValue(['sex']);
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(flaggedVersion(false));
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

describe('registration', () => {
  // The whole callback wiring is this lookup — /api/webhooks/text-moderation-result dispatches
  // by entityType, and the retry cron reads the same registry. Unregistered means every verdict
  // is silently dropped on arrival.
  it('is reachable from the shared moderation-adapter registry', () => {
    expect(getModerationAdapter('ModelVersion')).toBe(modelVersionModerationAdapter);
  });
});

describe('the term list decides', () => {
  it('flags on a match, at save time, before any scan comes back', async () => {
    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora' });

    expect(flagWrites()).toEqual([expect.objectContaining({ nsfw: true, versionId: 7 })]);
  });

  it('submits the name alone for review after flagging it', async () => {
    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora' });

    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'ModelVersion', entityId: 7, content: 'Sex Act Lora' })
    );
  });

  // The flag is a function of the CURRENT name, so a rename re-decides in both directions. This
  // is the creator's only self-serve remedy, and it clears on the same evidence the flag was
  // set on rather than on an unscanned assertion.
  it('clears a standing flag when the new name matches nothing', async () => {
    vi.mocked(matchModelVersionNameTerms).mockResolvedValue([]);
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(flaggedVersion(true));

    await moderateModelVersionName({ id: 7, name: 'v1.0' });

    expect(flagWrites()).toEqual([expect.objectContaining({ nsfw: false, versionId: 7 })]);
    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  // The term gate is what makes this affordable on every save — it keeps the LLM off the
  // overwhelming majority of names, which are `v1.0` and carry nothing to classify.
  it('does not submit when no curated term matches', async () => {
    vi.mocked(matchModelVersionNameTerms).mockResolvedValue([]);

    await moderateModelVersionName({ id: 7, name: 'v1.0' });

    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  // A moderator renaming a version is making a decision; an unattended pass must not re-flip it.
  it('skips moderator-authored saves', async () => {
    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora', isModerator: true });

    expect(matchModelVersionNameTerms).not.toHaveBeenCalled();
    expect(flagWrites()).toEqual([]);
    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  it('never throws — a failed scan must not fail the save', async () => {
    vi.mocked(matchModelVersionNameTerms).mockRejectedValue(new Error('redis down'));

    await expect(
      moderateModelVersionName({ id: 7, name: 'Sex Act Lora' })
    ).resolves.toBeUndefined();
  });
});

describe('the off switch', () => {
  // An unconfigured list has to stop the CLEAR as well as the flag. `matchModelVersionNameTerms`
  // returns nothing both when the feature is off and when a name is clean, so a gate placed
  // after the match would read "feature off" as "every name is clean" and strip every standing
  // flag on the next save.
  it('does not clear a standing flag when no terms are configured at all', async () => {
    vi.mocked(getModelVersionNameTerms).mockResolvedValue({ triggers: [] });
    vi.mocked(matchModelVersionNameTerms).mockResolvedValue([]);
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(flaggedVersion(true));

    await moderateModelVersionName({ id: 7, name: 'v1.0' });

    expect(flagWrites()).toEqual([]);
  });

  it('does not flag or submit when no terms are configured at all', async () => {
    vi.mocked(getModelVersionNameTerms).mockResolvedValue({ triggers: [] });

    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora' });

    expect(flagWrites()).toEqual([]);
    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  it('the retry cron sees the adapter as disabled when no terms are configured', async () => {
    vi.mocked(getModelVersionNameTerms).mockResolvedValue({ triggers: [] });

    // Without this the cron burns each row's whole retry budget against a feature that is off,
    // and those rows are then excluded from retry selection even after it is turned back on.
    expect(await modelVersionModerationAdapter.isEnabled?.({ entityId: 7 })).toBe(false);
  });
});

describe('the scan only overturns', () => {
  // The direction guard. XGuard reads a two-word title poorly, so it is asked the narrow
  // question — is the list wrong — and never the broad one.
  it('never raises the flag, however confident the verdict', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(flaggedVersion(false));

    await modelVersionModerationAdapter.applyResult?.(applyArgs(agrees(0.99), ['Suggestive']));

    expect(flagWrites().filter((w) => w.nsfw === true)).toEqual([]);
  });

  it('clears the flag when nothing triggered', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(flaggedVersion(true));

    await modelVersionModerationAdapter.applyResult?.(applyArgs(overturns()));

    expect(flagWrites()).toEqual([expect.objectContaining({ nsfw: false, versionId: 7 })]);
  });

  it('leaves the flag standing when a level label triggered', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(flaggedVersion(true));

    await modelVersionModerationAdapter.applyResult?.(applyArgs(agrees(), ['Suggestive']));

    expect(flagWrites()).toEqual([]);
  });

  // A floor on top of XGuard's own thresholds belongs on the path where the classifier DECIDES.
  // Re-adding one here would clear every verdict below it — and 98.3% of its triggers sit in the
  // 0.50-0.70 band, so the feature would quietly overturn nearly everything it flagged.
  it('leaves the flag standing on a level label that only just triggered', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(flaggedVersion(true));

    await modelVersionModerationAdapter.applyResult?.(applyArgs(agrees(0.51), ['Suggestive']));

    expect(flagWrites()).toEqual([]);
  });

  // Fifteen labels are sent and only three speak to the level. A Celebrity hit is not a reason
  // to keep an NSFW flag standing.
  it('clears when only a non-level label triggered', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(flaggedVersion(true));

    await modelVersionModerationAdapter.applyResult?.(
      applyArgs(agrees(0.99, 'Celebrity'), ['Celebrity'])
    );

    expect(flagWrites()).toEqual([expect.objectContaining({ nsfw: false })]);
  });
});

describe("a moderator's ruling", () => {
  // The reason this exists: without it a ruling survives only until the next rename. The term
  // list runs on the new name, re-decides, and overturns the moderator with nothing recorded.
  it('stops the term list re-flagging a version a moderator ruled safe', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(flaggedVersion(false, RULING));

    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora' });

    expect(flagWrites()).toEqual([]);
  });

  // Both unattended paths, not just the write path — the scan is equally unattended, and a
  // guard on one of the two callers is the guard that is not enforced.
  it('stops the scan clearing a version a moderator ruled NSFW', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(
      flaggedVersion(true, { ...RULING, nsfw: true })
    );

    await modelVersionModerationAdapter.applyResult?.(applyArgs(overturns()));

    expect(flagWrites()).toEqual([]);
  });

  // The read and the write are two statements; a ruling landing between them would otherwise be
  // overwritten by a decision made before it existed.
  it('repeats the guard in the WHERE, not only in the read', async () => {
    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora' });

    expect(flagWrites()[0].sql).toContain(`meta -> 'nsfwDecision' IS NULL`);
  });

  it('leaves an unruled version alone', async () => {
    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora' });

    expect(flagWrites()).toEqual([expect.objectContaining({ nsfw: true })]);
  });
});

describe('the write', () => {
  // Raising the flag on a system-owned model is refused by a database trigger. LOWERING it is
  // not refused and is worse: the derivation has no branch for an unflagged system-owned
  // version, so the row keeps the NSFW level with the flag gone and nothing revisits it.
  it('excludes system-owned models in the WHERE, in both directions', async () => {
    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora' });
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(flaggedVersion(true));
    await modelVersionModerationAdapter.applyResult?.(applyArgs(overturns()));

    const writes = flagWrites();
    expect(writes).toHaveLength(2);
    for (const write of writes) expect(write.sql).toContain('m."userId" > -1');
  });

  // Sets the flag, never the level. `nsfw` is an INPUT to the derivation — writing a level
  // directly would be overwritten by the next recompute.
  it('writes nsfw and not nsfwLevel', async () => {
    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora' });

    expect(flagWrites()[0].sql).not.toContain('nsfwLevel');
  });

  // The trigger enqueues a recompute a minute out; this makes the change visible now. The model
  // rollup too — under the safeCount branch, a version joining or leaving the flagged set can
  // move the model's own level.
  it('recomputes the version level and the model rollup inline', async () => {
    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora' });

    expect(updateModelVersionNsfwLevels).toHaveBeenCalledExactlyOnceWith([7]);
    expect(updateModelNsfwLevels).toHaveBeenCalledExactlyOnceWith([3]);
  });

  it('does nothing when the guarded write matches no row', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);

    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora' });

    expect(updateModelVersionNsfwLevels).not.toHaveBeenCalled();
    expect(entityChangesMock).not.toHaveBeenCalled();
  });

  it('does not write when the flag already holds the value', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(flaggedVersion(true));

    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora' });

    expect(flagWrites()).toEqual([]);
    // Still submitted: the standing flag has not necessarily been reviewed yet.
    expect(submitTextModeration).toHaveBeenCalled();
  });

  it('does nothing when the version was deleted between submit and callback', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(null);

    await modelVersionModerationAdapter.applyResult?.(applyArgs(overturns()));

    expect(flagWrites()).toEqual([]);
  });

  it('attributes both directions to the system in the change history', async () => {
    await moderateModelVersionName({ id: 7, name: 'Sex Act Lora' });
    const set = entityChangesMock.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(set.find((r) => r.field === 'nsfw')).toMatchObject({
      entityType: 'ModelVersion',
      entityId: 7,
      actorRole: 'system',
      reason: 'version-name-terms',
    });

    entityChangesMock.mockClear();
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(flaggedVersion(true));
    await modelVersionModerationAdapter.applyResult?.(applyArgs(overturns()));
    const cleared = entityChangesMock.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(cleared.find((r) => r.field === 'nsfw')).toMatchObject({
      actorRole: 'system',
      reason: 'xguard-version-name-review',
    });
  });
});
