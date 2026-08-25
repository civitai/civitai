import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';

/**
 * Model VERSION name moderation.
 *
 * The two properties worth guarding are the ones that would fail silently: the SCORE FLOOR,
 * without which the feature flags on XGuard's noise floor for short strings, and the
 * SYSTEM-OWNED exclusion, without which a flag lands somewhere it can never be cleared from.
 */

const { entityChangesMock } = vi.hoisted(() => ({ entityChangesMock: vi.fn() }));

vi.mock('~/server/services/text-moderation.service', () => ({ submitTextModeration: vi.fn() }));
vi.mock('~/server/services/nsfwLevels.service', () => ({
  updateModelVersionNsfwLevels: vi.fn(),
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

const { modelVersionModerationAdapter, submitModelVersionNameModeration } = await import(
  '~/server/services/model-version-moderation.adapter'
);
const { updateModelVersionNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { submitTextModeration } = await import('~/server/services/text-moderation.service');
const { getModelVersionNameTerms, matchModelVersionNameTerms } = await import(
  '~/server/services/model-version-name-terms.service'
);
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');

const outputWith = (score: number, label = 'Suggestive') =>
  ({
    triggeredLabels: [label],
    results: [{ label, score, threshold: 0.5, triggered: true }],
  } as never);

const applyArgs = (score: number) => ({
  entityId: 7,
  workflowId: 'wf-1',
  blocked: false,
  triggeredLabels: ['Suggestive'],
  output: outputWith(score),
});

const rawCalls = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.map((call: unknown[]) => ({
    sql: (call[0] as unknown as readonly string[]).join('?'),
    values: call.slice(1),
  }));
const flipCall = () => rawCalls().find((c) => c.sql.includes('SET nsfw = TRUE'));

beforeEach(() => {
  vi.clearAllMocks();
  entityChangesMock.mockResolvedValue(undefined);
  vi.mocked(getModelVersionNameTerms).mockResolvedValue({
    spec: { triggers: ['sex'] },
    config: { minScore: 0.85 },
  });
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
    id: 7,
    name: 'Sex Act Lora',
    nsfw: false,
    modelId: 3,
    model: { userId: 99 },
  });
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

describe('the score floor', () => {
  // Measured over 2,000 random version names: XGuard returns `suggestive` 0.55-0.69 on
  // contentless strings like `v1.0`, which clears its own 0.50 threshold. Without this floor
  // the feature flags four names in five on the classifier's noise.
  it('does not apply a verdict below the configured floor', async () => {
    await modelVersionModerationAdapter.applyResult?.(applyArgs(0.62));

    expect(flipCall()).toBeUndefined();
    expect(updateModelVersionNsfwLevels).not.toHaveBeenCalled();
  });

  it('applies at or above the floor', async () => {
    await modelVersionModerationAdapter.applyResult?.(applyArgs(0.9));

    expect(flipCall()).toBeDefined();
    expect(updateModelVersionNsfwLevels).toHaveBeenCalledExactlyOnceWith([7]);
  });

  // The floor is runtime config, not a constant — a hardcoded 0.85 would ignore the tuning.
  it('reads the floor from config rather than hardcoding it', async () => {
    vi.mocked(getModelVersionNameTerms).mockResolvedValue({
      spec: { triggers: ['sex'] },
      config: { minScore: 0.5 },
    });

    await modelVersionModerationAdapter.applyResult?.(applyArgs(0.62));

    expect(flipCall()).toBeDefined();
  });
});

describe('the write', () => {
  // The derivation has no branch for an unflagged system-owned version, so a flag set there can
  // never be cleared. A database trigger refuses it; this predicate keeps the callback from
  // tripping that and failing the whole webhook.
  it('excludes system-owned models in the WHERE', async () => {
    await modelVersionModerationAdapter.applyResult?.(applyArgs(0.9));

    expect(flipCall()?.sql).toContain('m."userId" > -1');
  });

  // Sets the flag, never the level. `nsfw` is an INPUT to the derivation — writing a level
  // directly would be overwritten by the next recompute.
  it('writes nsfw and not nsfwLevel', async () => {
    await modelVersionModerationAdapter.applyResult?.(applyArgs(0.9));

    expect(flipCall()?.sql).toContain('SET nsfw = TRUE');
    expect(flipCall()?.sql).not.toContain('nsfwLevel');
  });

  // The trigger enqueues a recompute a minute out; this makes the change visible now. Dropping
  // it leaves the flag set and the level stale until the next cron tick.
  it('recomputes the level inline rather than waiting for the trigger', async () => {
    await modelVersionModerationAdapter.applyResult?.(applyArgs(0.9));

    expect(updateModelVersionNsfwLevels).toHaveBeenCalledExactlyOnceWith([7]);
  });

  it('does nothing when the guarded write matches no row', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);

    await modelVersionModerationAdapter.applyResult?.(applyArgs(0.9));

    expect(updateModelVersionNsfwLevels).not.toHaveBeenCalled();
    expect(entityChangesMock).not.toHaveBeenCalled();
  });

  it('attributes the flip to the system in the change history', async () => {
    await modelVersionModerationAdapter.applyResult?.(applyArgs(0.9));

    const rows = entityChangesMock.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.field === 'nsfw')).toMatchObject({
      entityType: 'ModelVersion',
      entityId: 7,
      actorRole: 'system',
      reason: 'xguard-version-name-moderation',
    });
  });

  it('does not act when only a non-level label triggers', async () => {
    await modelVersionModerationAdapter.applyResult?.({
      ...applyArgs(0.99),
      triggeredLabels: ['Celebrity'],
      output: outputWith(0.99, 'Celebrity'),
    });

    expect(flipCall()).toBeUndefined();
  });

  it('does not act on a version that is already flagged', async () => {
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
      id: 7,
      name: 'Sex Act Lora',
      nsfw: true,
      modelId: 3,
      model: { userId: 99 },
    });

    await modelVersionModerationAdapter.applyResult?.(applyArgs(0.9));

    expect(flipCall()).toBeUndefined();
    expect(entityChangesMock).not.toHaveBeenCalled();
  });
});

describe('submitModelVersionNameModeration', () => {
  // The term gate is what makes this affordable on every save — it keeps the LLM off the
  // overwhelming majority of names, which are `v1.0` and carry nothing to classify.
  it('does not submit when no curated term matches', async () => {
    vi.mocked(matchModelVersionNameTerms).mockResolvedValue([]);

    await submitModelVersionNameModeration({ id: 7, name: 'v1.0' });

    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  it('submits the name alone when a term matches', async () => {
    vi.mocked(matchModelVersionNameTerms).mockResolvedValue(['sex']);

    await submitModelVersionNameModeration({ id: 7, name: 'Sex Act Lora' });

    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'ModelVersion', entityId: 7, content: 'Sex Act Lora' })
    );
  });

  // A moderator renaming a version is making a decision; an unattended scan must not re-flip it.
  it('skips moderator-authored saves', async () => {
    vi.mocked(matchModelVersionNameTerms).mockResolvedValue(['sex']);

    await submitModelVersionNameModeration({ id: 7, name: 'Sex Act Lora', isModerator: true });

    expect(matchModelVersionNameTerms).not.toHaveBeenCalled();
    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  it('never throws — a failed scan must not fail the save', async () => {
    vi.mocked(matchModelVersionNameTerms).mockRejectedValue(new Error('redis down'));

    await expect(
      submitModelVersionNameModeration({ id: 7, name: 'Sex Act Lora' })
    ).resolves.toBeUndefined();
  });

  // The configured term list IS the off switch, now that there is no feature flag in front of
  // it. An empty list has to mean "scan nothing", or the feature has no way to be turned off
  // without a deploy.
  it('does not submit when no terms are configured at all', async () => {
    vi.mocked(matchModelVersionNameTerms).mockResolvedValue(['sex']);
    vi.mocked(getModelVersionNameTerms).mockResolvedValue({
      spec: { triggers: [] },
      config: { minScore: 0.85 },
    });

    await submitModelVersionNameModeration({ id: 7, name: 'Sex Act Lora' });

    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  it('the retry cron sees the adapter as disabled when no terms are configured', async () => {
    vi.mocked(getModelVersionNameTerms).mockResolvedValue({
      spec: { triggers: [] },
      config: { minScore: 0.85 },
    });

    // Without this the cron burns each row's whole retry budget against a feature that is off,
    // and those rows are then excluded from retry selection even after it is turned back on.
    expect(await modelVersionModerationAdapter.isEnabled?.({ entityId: 7 })).toBe(false);
  });
});
