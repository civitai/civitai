import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
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

const { modelModerationAdapter } = await import('~/server/services/model-moderation.adapter');
const { updateModelNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { isFlipt } = await import('~/server/flipt/client');

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
});

describe('MODEL_MODERATION_SCAN_LABELS', () => {
  it('covers all fifteen registry labels', () => {
    expect(MODEL_MODERATION_SCAN_LABELS).toHaveLength(15);
  });
});
