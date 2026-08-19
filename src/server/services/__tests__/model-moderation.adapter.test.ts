import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  buildModelModerationText,
  isModelTextNsfw,
  MODEL_MODERATION_SCAN_LABELS,
} from '~/server/services/model-moderation.adapter';

vi.mock('~/server/services/text-moderation.service', () => ({ submitTextModeration: vi.fn() }));
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateModelNsfwLevels: vi.fn() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/flipt/client')>()),
  isFlipt: vi.fn(),
}));
// Read path only. `env.REPLICATION_LAG_DELAY` is undefined (not 0) under the env mock, so the
// real function's `<= 0` short-circuit does not fire — override it directly rather than rely
// on that, matching article-locked-properties.service.test.ts's pattern for the same helper.
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/db/db-lag-helpers')>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));

const { modelModerationAdapter } = await import('~/server/services/model-moderation.adapter');
const { updateModelNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { isFlipt } = await import('~/server/flipt/client');
const { submitTextModeration } = await import('~/server/services/text-moderation.service');
const { getDbWithoutLag } = await import('~/server/db/db-lag-helpers');

const okOutput = (triggeredLabels: string[], blocked = false) =>
  ({
    blocked,
    triggeredLabels,
    results: triggeredLabels.map((label) => ({
      label,
      score: 0.9,
      threshold: 0.5,
      matchedTerms: { text: ['matched phrase'], positivePrompt: [], negativePrompt: [] },
    })),
  } as never);

const applyArgs = (triggeredLabels: string[], blocked = false) => ({
  entityId: 1,
  workflowId: 'wf-1',
  blocked,
  triggeredLabels,
  output: okOutput(triggeredLabels, blocked),
});

describe('modelModerationAdapter.applyResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isFlipt).mockResolvedValue(true);
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      id: 1,
      nsfw: false,
      lockedProperties: [],
      meta: {},
      userId: 99,
    });
    dbMock.dbWrite.model.update.mockResolvedValue({ id: 1 });
  });

  // T1
  it('flips nsfw and locks the property when a level label triggers', async () => {
    await modelModerationAdapter.applyResult?.(applyArgs(['Suggestive']));

    expect(dbMock.dbWrite.model.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ nsfw: true, lockedProperties: ['nsfw'] }),
      })
    );
    expect(updateModelNsfwLevels).toHaveBeenCalledWith([1]);
  });

  // A moderation write is exactly the case a replication-lag read must not miss a lock a
  // moderator set seconds earlier — see FIX-BEFORE-RAMP 4.
  it('reads the model through getDbWithoutLag, not a bare replica read', async () => {
    await modelModerationAdapter.applyResult?.(applyArgs(['Suggestive']));

    expect(getDbWithoutLag).toHaveBeenCalledWith('model', 1);
  });

  // T2 — the submit sends 15 labels; a Review-action label must not act.
  it('does not write when only a non-level label triggers', async () => {
    await modelModerationAdapter.applyResult?.(applyArgs(['Sex Trafficking', 'Grooming']));

    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
    expect(updateModelNsfwLevels).not.toHaveBeenCalled();
  });

  // T3 — the regression this guards is someone reintroducing `if (blocked) …`.
  it('ignores output.blocked when no level label triggered', async () => {
    await modelModerationAdapter.applyResult?.(applyArgs(['Scat'], true));

    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });

  // T4 — a stored lock is a moderator's call. Minor-flagging sets nsfw:false and locks it.
  // FINDING 1 — a locked nsfw:true row can still be stuck at SFW browsing level / stale in
  // search if a prior call wrote nsfw and died before running updateModelNsfwLevels; since
  // EntityModeration is already Succeeded by then, a replayed callback is the only thing that
  // gets another chance to repair it. nsfw:false has no drift to repair.
  it.each([false, true])('does not write when nsfw is locked (stored nsfw=%s)', async (nsfw) => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      id: 1,
      nsfw,
      lockedProperties: ['nsfw'],
      meta: {},
      userId: 99,
    });

    await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));

    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
    if (nsfw) {
      expect(updateModelNsfwLevels).toHaveBeenCalledWith([1]);
    } else {
      expect(updateModelNsfwLevels).not.toHaveBeenCalled();
    }
  });

  // FINDING 2 — every other fixture uses lockedProperties: [], which cannot distinguish
  // `uniq([...stored, 'nsfw'])` from a flat `['nsfw']` that would silently wipe an existing lock.
  it('preserves an existing non-nsfw lock entry when adding the nsfw lock', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      id: 1,
      nsfw: false,
      lockedProperties: ['poi'],
      meta: {},
      userId: 99,
    });

    await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));

    expect(dbMock.dbWrite.model.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lockedProperties: ['poi', 'nsfw'] }),
      })
    );
  });

  // T5 — the shadow phase must not apply.
  it('records but does not write when the apply flag is off', async () => {
    vi.mocked(isFlipt).mockResolvedValue(false);

    await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));

    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
    expect(updateModelNsfwLevels).not.toHaveBeenCalled();
  });

  // T6 — deleted between submit and callback; a bare update would throw P2025.
  it('returns cleanly when the model is gone', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(null);

    await expect(
      modelModerationAdapter.applyResult?.(applyArgs(['Explicit']))
    ).resolves.not.toThrow();
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
  });

  // T9 — against a real database the second call hits the stored-lock early return and writes
  // nothing, so the two findUnique results here mirror pre-write then post-write DB state rather
  // than repeating the same snapshot (which would pass even with replay protection broken).
  it('is idempotent across a replayed callback', async () => {
    dbMock.dbRead.model.findUnique
      .mockResolvedValueOnce({ id: 1, nsfw: false, lockedProperties: [], meta: {}, userId: 99 })
      .mockResolvedValueOnce({ id: 1, nsfw: true, lockedProperties: ['nsfw'], meta: {}, userId: 99 });

    await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));
    await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));

    expect(dbMock.dbWrite.model.update).toHaveBeenCalledTimes(1);
  });

  it('records matched terms on meta.textModeration', async () => {
    await modelModerationAdapter.applyResult?.(applyArgs(['Suggestive']));

    const data = dbMock.dbWrite.model.update.mock.calls[0][0].data;
    expect(data.meta.textModeration.matchedTerms).toEqual(['matched phrase']);
    expect(data.meta.textModeration.triggeredLabels).toEqual(['Suggestive']);
  });

  // FINDING 3 — `okOutput` builds `results` from exactly `triggeredLabels`, so every result is a
  // triggered one there; that can't exercise the filter that is collectMatchedTerms's whole reason
  // to exist. The real webhook passes the RAW XGuardModerationOutput (not the slimmed one), so
  // `results` carries all 15 submitted labels, including non-triggered ones that may still carry
  // matchedTerms — and label casing between `results` and `triggeredLabels` is not guaranteed to
  // match.
  it('excludes matchedTerms from non-triggered labels and matches triggered ones case-insensitively', async () => {
    const output = {
      blocked: false,
      triggeredLabels: ['explicit', 'Suggestive'],
      results: [
        {
          label: 'Explicit',
          score: 0.9,
          threshold: 0.5,
          matchedTerms: { text: ['explicit term'], positivePrompt: [], negativePrompt: [] },
        },
        // Casing differs from `triggeredLabels` above — must still match.
        {
          label: 'SUGGESTIVE',
          score: 0.9,
          threshold: 0.5,
          matchedTerms: { text: ['suggestive term'], positivePrompt: [], negativePrompt: [] },
        },
        // Not triggered (score < threshold) but still carries matchedTerms, as the raw payload
        // does — must be excluded.
        {
          label: 'NSFW',
          score: 0.1,
          threshold: 0.5,
          matchedTerms: { text: ['should be excluded'], positivePrompt: [], negativePrompt: [] },
        },
      ],
    } as never;

    await modelModerationAdapter.applyResult?.({
      entityId: 1,
      workflowId: 'wf-1',
      blocked: false,
      triggeredLabels: ['explicit', 'Suggestive'],
      output,
    });

    const data = dbMock.dbWrite.model.update.mock.calls[0][0].data;
    expect([...data.meta.textModeration.matchedTerms].sort()).toEqual([
      'explicit term',
      'suggestive term',
    ]);
  });

  // IMPORTANT 3(b) — a label the scanner never answers must not read as a clean 0% rate.
  // Logged unconditionally, ahead of the nsfw-verdict early return: the shadow phase needs
  // this signal on every callback, not only the ones that also happened to trigger.
  it('logs missing requested labels to Axiom, even when nothing triggered', async () => {
    await modelModerationAdapter.applyResult?.(applyArgs([]));

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'model-text-moderation',
        modelId: 1,
        missingLabels: expect.arrayContaining(MODEL_MODERATION_SCAN_LABELS as unknown as string[]),
      })
    );
  });

  it('does not log missing labels when every requested label answered', async () => {
    const output = {
      blocked: false,
      triggeredLabels: [],
      results: MODEL_MODERATION_SCAN_LABELS.map((label) => ({
        label,
        score: 0.1,
        threshold: 0.5,
        matchedTerms: { text: [], positivePrompt: [], negativePrompt: [] },
      })),
    } as never;

    await modelModerationAdapter.applyResult?.({
      entityId: 1,
      workflowId: 'wf-1',
      blocked: false,
      triggeredLabels: [],
      output,
    });

    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'model-text-moderation', message: expect.stringContaining('missing') })
    );
  });
});

describe('modelModerationAdapter.submit', () => {
  beforeEach(() => vi.clearAllMocks());

  // FIX-BEFORE-RAMP 5 — off must mean "no scan is requested at all," including from the
  // retry cron, which calls this hook directly rather than through submitModelTextModeration.
  it('submits the full label list at low priority, recorded for review, when the flag is on', async () => {
    vi.mocked(isFlipt).mockResolvedValue(true);
    vi.mocked(submitTextModeration).mockResolvedValue({ id: 'wf-1' });

    const result = await modelModerationAdapter.submit({ entityId: 5, content: 'some text' });

    expect(isFlipt).toHaveBeenCalledWith('model-text-moderation-xguard', '5');
    expect(submitTextModeration).toHaveBeenCalledWith({
      entityType: 'Model',
      entityId: 5,
      content: 'some text',
      labels: [...MODEL_MODERATION_SCAN_LABELS],
      priority: 'low',
      recordForReview: true,
    });
    expect(result).toEqual({ id: 'wf-1' });
  });

  it('does not submit when the flag is off, so a retry-cron tick cannot spend on a dark feature', async () => {
    vi.mocked(isFlipt).mockResolvedValue(false);

    const result = await modelModerationAdapter.submit({ entityId: 5, content: 'some text' });

    expect(submitTextModeration).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

// T7 — the drift this guards is silent: dedup stops hitting and nothing errors.
describe('modelModerationAdapter.resolveContent', () => {
  it('produces the same string buildModelModerationText does', async () => {
    const row = { id: 1, name: 'My LoRA', description: '<p>text</p>' };
    dbMock.dbRead.model.findMany.mockResolvedValue([row]);

    const map = await modelModerationAdapter.resolveContent([1]);

    expect(map.get(1)).toBe(buildModelModerationText(row));
  });

  it('omits models that no longer exist so the retry job cleans their rows up', async () => {
    dbMock.dbRead.model.findMany.mockResolvedValue([]);

    expect((await modelModerationAdapter.resolveContent([1, 2])).size).toBe(0);
  });
});

describe('buildModelModerationText', () => {
  it('joins name and tag-stripped description', () => {
    expect(
      buildModelModerationText({ name: 'My LoRA', description: '<p>A <b>style</b> model</p>' })
    ).toBe('My LoRA A style model');
  });

  it('omits a missing description rather than emitting a trailing space', () => {
    expect(buildModelModerationText({ name: 'My LoRA', description: null })).toBe('My LoRA');
  });

  it('collapses whitespace so two equivalent descriptions hash identically', () => {
    const a = buildModelModerationText({ name: 'X', description: '<p>a</p>\n<p>b</p>' });
    const b = buildModelModerationText({ name: 'X', description: '<p>a</p>    <p>b</p>' });
    expect(a).toBe(b);
  });
});

describe('isModelTextNsfw', () => {
  it.each(['NSFW', 'Suggestive', 'Explicit', 'nsfw', 'suggestive', 'explicit'])(
    'triggers on the level label %s regardless of case',
    (label) => {
      expect(isModelTextNsfw({ triggeredLabels: [label] })).toBe(true);
    }
  );

  // The submit sends 15 labels; only 3 may act. A Review/Block label triggering must not
  // flip nsfw — that is the difference between this and honouring `output.blocked`.
  it.each(['Young', 'Grooming', 'Sex Trafficking', 'Bestiality', 'Celebrity', 'Scat'])(
    'does NOT trigger on the non-level label %s',
    (label) => {
      expect(isModelTextNsfw({ triggeredLabels: [label] })).toBe(false);
    }
  );

  it('is false when nothing triggered', () => {
    expect(isModelTextNsfw({ triggeredLabels: [] })).toBe(false);
    expect(isModelTextNsfw({})).toBe(false);
  });

  // IMPORTANT 3(a) — `triggeredLabels` and `results[]` are two views of the same fact across a
  // network boundary; a level label present in only one view must still count.
  it('triggers on results[].triggered === true even when absent from triggeredLabels', () => {
    expect(
      isModelTextNsfw({
        triggeredLabels: [],
        results: [
          { label: 'Explicit', score: 0.9, threshold: 0.5, triggered: true } as never,
        ],
      })
    ).toBe(true);
  });

  it('triggers on score >= threshold even when triggered is false/absent', () => {
    expect(
      isModelTextNsfw({
        triggeredLabels: [],
        results: [{ label: 'Suggestive', score: 0.7, threshold: 0.5 } as never],
      })
    ).toBe(true);
  });

  it('does not trigger on a non-level label regardless of score', () => {
    expect(
      isModelTextNsfw({
        triggeredLabels: [],
        results: [{ label: 'Celebrity', score: 0.99, threshold: 0.1, triggered: true } as never],
      })
    ).toBe(false);
  });

  it('does not trigger below threshold with no explicit triggered flag', () => {
    expect(
      isModelTextNsfw({
        triggeredLabels: [],
        results: [{ label: 'NSFW', score: 0.1, threshold: 0.5 } as never],
      })
    ).toBe(false);
  });
});

describe('MODEL_MODERATION_SCAN_LABELS', () => {
  // A rename or reorder must fail this — per-label trigger rates are keyed on these exact
  // strings, and a silent drift here is IMPORTANT 3's whole failure mode.
  it('is the exact fifteen labels, in order', () => {
    expect(MODEL_MODERATION_SCAN_LABELS).toEqual([
      'NSFW',
      'Suggestive',
      'Explicit',
      'Young',
      'Grooming',
      'Sex Trafficking',
      'Exploitation',
      'Extremism',
      'Impersonating Civitai Staff',
      'Bestiality',
      'Urine',
      'Diaper',
      'Scat',
      'Menstruation',
      'Celebrity',
    ]);
  });
});
