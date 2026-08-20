import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  buildModelModerationText,
  isModelTextNsfw,
  MODEL_MODERATION_SCAN_LABELS,
  resolveBackfillCursor,
} from '~/server/services/model-moderation.adapter';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as FliptClient from '~/server/flipt/client';

const { entityChangesMock } = vi.hoisted(() => ({ entityChangesMock: vi.fn() }));

vi.mock('~/server/services/text-moderation.service', () => ({ submitTextModeration: vi.fn() }));
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateModelNsfwLevels: vi.fn() }));
// Hand-listed rather than spread from the original: `model-version.service` builds Redis
// clients and prom collectors at load, and pulling that graph in here is what turns a suite
// into a zero-collection pass. Same reasoning as the two above.
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: vi.fn(),
}));
vi.mock('~/server/clickhouse/tracker', () => ({
  // A class, not `vi.fn(() => ({...}))`: the adapter constructs this with `new`, and a plain
  // arrow mock is not constructible.
  Tracker: class {
    entityChanges = entityChangesMock;
  },
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Read path only. `env.REPLICATION_LAG_DELAY` is undefined (not 0) under the env mock, so the
// real function's `<= 0` short-circuit does not fire — override it directly rather than rely
// on that, matching article-locked-properties.service.test.ts's pattern for the same helper.
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));

const { modelModerationAdapter } = await import('~/server/services/model-moderation.adapter');
const { updateModelNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { bustPublicModelResponseCache } = await import('~/server/services/model-version.service');
const { isFlipt } = await import('~/server/flipt/client');
const { submitTextModeration } = await import('~/server/services/text-moderation.service');
const { getDbWithoutLag } = await import('~/server/db/db-lag-helpers');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');

const SUBMIT_FLAG = 'model-text-moderation-xguard';
const APPLY_FLAG = 'model-text-moderation-xguard-apply';

/**
 * Answers per flag KEY. A blanket `mockResolvedValue(true/false)` cannot tell the submit gate
 * from the apply gate, so swapping one for the other in the adapter stays green — which is the
 * whole two-flag safety story going unasserted.
 */
const flags = (enabled: Record<string, boolean>) =>
  vi.mocked(isFlipt).mockImplementation(async (flag) => enabled[flag as string] ?? false);

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

// `$executeRaw` is a tagged template, so a call arrives as (strings, ...boundValues). Splitting
// the two raw statements on their SQL keeps the assertions readable and makes a revert that
// drops one of them fail by name rather than by index.
const rawCalls = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.map((call: unknown[]) => ({
    sql: (call[0] as unknown as readonly string[]).join('?'),
    values: call.slice(1),
  }));
const flipCall = () => rawCalls().find((c) => c.sql.includes('SET nsfw = TRUE'));
const forensicsCall = () => rawCalls().find((c) => c.sql.includes("'textModeration'"));

const modelRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  nsfw: false,
  nsfwLevel: 1,
  lockedProperties: [],
  userId: 99,
  ...over,
});

describe('modelModerationAdapter.applyResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    entityChangesMock.mockResolvedValue(undefined);
    flags({ [SUBMIT_FLAG]: true, [APPLY_FLAG]: true });
    dbMock.dbRead.model.findUnique.mockResolvedValue(modelRow());
    // Rows affected. The flip is guarded in its own WHERE, so 0 means "a lock landed first".
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  });

  it('flips nsfw and locks the property when a level label triggers', async () => {
    await modelModerationAdapter.applyResult?.(applyArgs(['Suggestive']));

    const flip = flipCall();
    expect(flip).toBeDefined();
    expect(flip?.sql).toContain('array_append');
    expect(flip?.values).toEqual([1]);
    expect(updateModelNsfwLevels).toHaveBeenCalledWith([1]);
  });

  // The flip happens outside upsertModel, which is the only other thing that busts this cache.
  // Without it GET /api/v1/models/[id] keeps serving the pre-flip body for the whole TTL,
  // including on the SFW-only key used for region-restricted requests.
  it('busts the public model response cache after flipping', async () => {
    await modelModerationAdapter.applyResult?.(applyArgs(['Suggestive']));

    expect(bustPublicModelResponseCache).toHaveBeenCalledWith(1);
  });

  // This write has no actor, so nothing else can attribute it. Without these rows a model
  // silently becomes NSFW with nothing in its change history to explain it.
  it('attributes the flip to the system in the change history', async () => {
    await modelModerationAdapter.applyResult?.(applyArgs(['Suggestive']));

    expect(entityChangesMock).toHaveBeenCalledTimes(1);
    const rows = entityChangesMock.mock.calls[0][0] as Array<Record<string, unknown>>;
    const nsfwRow = rows.find((r) => r.field === 'nsfw');
    expect(nsfwRow).toMatchObject({
      entityType: 'Model',
      entityId: 1,
      ownerId: 99,
      actorRole: 'system',
      reason: 'xguard-text-moderation',
    });
    expect(rows.find((r) => r.field === 'lockedProperties')).toMatchObject({
      actorRole: 'system',
      reason: 'xguard-text-moderation',
    });
  });

  // A moderation write is exactly the case a replication-lag read must not miss a lock a
  // moderator set seconds earlier.
  it('reads the model through getDbWithoutLag, not a bare replica read', async () => {
    await modelModerationAdapter.applyResult?.(applyArgs(['Suggestive']));

    expect(getDbWithoutLag).toHaveBeenCalledWith('model', 1);
  });

  // The submit sends 15 labels; a Review-action label must not act.
  it('does not write when only a non-level label triggers', async () => {
    await modelModerationAdapter.applyResult?.(applyArgs(['Sex Trafficking', 'Grooming']));

    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(updateModelNsfwLevels).not.toHaveBeenCalled();
  });

  // The regression this guards is someone reintroducing `if (blocked) …`.
  it('ignores output.blocked when no level label triggered', async () => {
    await modelModerationAdapter.applyResult?.(applyArgs(['Scat'], true));

    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  describe('when a moderator has locked nsfw', () => {
    // A stored lock is a moderator's call — minor-flagging sets nsfw:false and locks it.
    it.each([false, true])('never flips the flag (stored nsfw=%s)', async (nsfw) => {
      dbMock.dbRead.model.findUnique.mockResolvedValue(
        modelRow({ nsfw, lockedProperties: ['nsfw'] })
      );

      await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));

      expect(flipCall()).toBeUndefined();
    });

    // The profanity branch records its matches on a locked model too — the lock stops the
    // ruling being overturned, not the detection being recorded. A moderator reviewing the
    // model needs to see that the scan disagreed with the lock.
    it('still records the forensics', async () => {
      dbMock.dbRead.model.findUnique.mockResolvedValue(modelRow({ lockedProperties: ['nsfw'] }));

      await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));

      expect(forensicsCall()?.values).toEqual([['matched phrase'], ['explicit'], 1]);
    });

    // A prior callback may have flipped nsfw and died before recomputing levels; a replayed
    // callback is the only thing that gets another chance to repair it.
    it('repairs a level that drifted from the flag', async () => {
      dbMock.dbRead.model.findUnique.mockResolvedValue(
        modelRow({ nsfw: true, nsfwLevel: 1, lockedProperties: ['nsfw'] })
      );

      await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));

      expect(updateModelNsfwLevels).toHaveBeenCalledWith([1]);
    });

    // `updateModelNsfwLevels` matches every `nsfw = true` row unconditionally, so calling it on
    // a correct row still writes, fires the model row trigger and queues a Meilisearch
    // re-render. Dropping this guard makes the repair fire on every callback for every
    // already-flagged model.
    it('does not recompute a level that is already correct', async () => {
      dbMock.dbRead.model.findUnique.mockResolvedValue(
        modelRow({ nsfw: true, nsfwLevel: nsfwBrowsingLevelsFlag, lockedProperties: ['nsfw'] })
      );

      await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));

      expect(updateModelNsfwLevels).not.toHaveBeenCalled();
    });

    it('has no drift to repair when the stored flag is false', async () => {
      dbMock.dbRead.model.findUnique.mockResolvedValue(
        modelRow({ nsfw: false, lockedProperties: ['nsfw'] })
      );

      await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));

      expect(updateModelNsfwLevels).not.toHaveBeenCalled();
    });
  });

  // The lock check and the flip are two statements. A moderator ruling that lands between them
  // must lose to the guard in the WHERE, not silently be overwritten.
  it('treats a lock that appears between read and write as a decline', async () => {
    dbMock.dbWrite.$executeRaw.mockImplementation(async (strings: readonly string[]) =>
      strings.join('?').includes('SET nsfw = TRUE') ? 0 : 1
    );

    await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));

    expect(updateModelNsfwLevels).not.toHaveBeenCalled();
    expect(bustPublicModelResponseCache).not.toHaveBeenCalled();
    expect(entityChangesMock).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'nsfw lock appeared between read and write; flag not applied',
      })
    );
  });

  describe('the apply flag', () => {
    // The shadow phase must not apply. Asserted with the submit flag ON so the test fails if
    // the adapter reads the wrong key, not only if it drops the gate entirely.
    it('gates the write independently of the submit flag', async () => {
      flags({ [SUBMIT_FLAG]: true, [APPLY_FLAG]: false });

      await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));

      expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
      expect(updateModelNsfwLevels).not.toHaveBeenCalled();
      expect(isFlipt).toHaveBeenCalledWith(APPLY_FLAG, '1');
    });

    // Keyed on the model so a percentage rollout picks a stable subset of content rather than
    // following an author around.
    it('is keyed on the model id', async () => {
      await modelModerationAdapter.applyResult?.({ ...applyArgs(['Explicit']), entityId: 77 });

      expect(isFlipt).toHaveBeenCalledWith(APPLY_FLAG, '77');
    });
  });

  // Deleted between submit and callback; a bare update would throw P2025 and the orchestrator
  // would retry the callback forever.
  it('returns cleanly when the model is gone', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue(null);

    await expect(
      modelModerationAdapter.applyResult?.(applyArgs(['Explicit']))
    ).resolves.not.toThrow();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  // Against a real database the second call hits the stored-lock early return, so the two
  // findUnique results mirror pre-write then post-write state rather than repeating the same
  // snapshot (which would pass even with replay protection broken).
  it('is idempotent across a replayed callback', async () => {
    dbMock.dbRead.model.findUnique
      .mockResolvedValueOnce(modelRow())
      .mockResolvedValueOnce(modelRow({ nsfw: true, lockedProperties: ['nsfw'] }));

    await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));
    await modelModerationAdapter.applyResult?.(applyArgs(['Explicit']));

    expect(rawCalls().filter((c) => c.sql.includes('SET nsfw = TRUE'))).toHaveLength(1);
  });

  describe('forensics', () => {
    it('records matched terms and the triggered labels', async () => {
      await modelModerationAdapter.applyResult?.(applyArgs(['Suggestive']));

      expect(forensicsCall()?.values).toEqual([['matched phrase'], ['suggestive'], 1]);
    });

    // The merge happens in the database. A read-modify-write of the whole object would erase a
    // `minorFlagSnapshot` written in the window between the read and the write — and that key
    // is what gates the owner's appeal flow, so its loss is silent and unrecoverable.
    it('merges into meta in SQL rather than overwriting the object', async () => {
      await modelModerationAdapter.applyResult?.(applyArgs(['Suggestive']));

      expect(forensicsCall()?.sql).toContain("COALESCE(m.meta, '{}'::jsonb) ||");
      expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
    });

    // XGuard sets the term cardinality from a body that can be 167 KB, and `Model.meta` is
    // selected for every row of the model feed — a column whose p99 is 310 bytes.
    it('caps how many matched terms are persisted', async () => {
      const terms = Array.from({ length: 120 }, (_, i) => `term-${i}`);
      await modelModerationAdapter.applyResult?.({
        entityId: 1,
        workflowId: 'wf-1',
        blocked: false,
        triggeredLabels: ['Explicit'],
        output: {
          blocked: false,
          triggeredLabels: ['Explicit'],
          results: [
            {
              label: 'Explicit',
              score: 0.9,
              threshold: 0.5,
              matchedTerms: { text: terms, positivePrompt: [], negativePrompt: [] },
            },
          ],
        } as never,
      });

      expect((forensicsCall()?.values[0] as string[]).length).toBe(50);
    });

    // `okOutput` builds `results` from exactly `triggeredLabels`, so every result there is a
    // triggered one and the filter that is collectMatchedTerms's whole reason to exist goes
    // unexercised. The real webhook passes the RAW output, whose `results` carry all fifteen
    // submitted labels — non-triggered ones included, casing not guaranteed to match.
    it('excludes non-triggered labels and matches triggered ones case-insensitively', async () => {
      await modelModerationAdapter.applyResult?.({
        entityId: 1,
        workflowId: 'wf-1',
        blocked: false,
        triggeredLabels: ['explicit', 'Suggestive'],
        output: {
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
            // Not triggered (score < threshold) but still carries matchedTerms, as the raw
            // payload does — must be excluded.
            {
              label: 'NSFW',
              score: 0.1,
              threshold: 0.5,
              matchedTerms: {
                text: ['should be excluded'],
                positivePrompt: [],
                negativePrompt: [],
              },
            },
          ],
        } as never,
      });

      expect([...(forensicsCall()?.values[0] as string[])].sort()).toEqual([
        'explicit term',
        'suggestive term',
      ]);
    });

    // The verdict unions `triggeredLabels` with `results[].triggered`/`score >= threshold`. If
    // the forensics filtered on `triggeredLabels` alone, this exact payload — the one the union
    // exists to catch — would flip the model while recording NO matched terms and NO label,
    // blanking the field precisely when a moderator most needs to know why.
    it('records a label that fired only in results[], not in triggeredLabels', async () => {
      await modelModerationAdapter.applyResult?.({
        entityId: 1,
        workflowId: 'wf-1',
        blocked: false,
        triggeredLabels: [],
        output: {
          blocked: false,
          triggeredLabels: [],
          results: [
            {
              label: 'Explicit',
              score: 0.9,
              threshold: 0.5,
              triggered: true,
              matchedTerms: {
                text: ['results-only term'],
                positivePrompt: [],
                negativePrompt: [],
              },
            },
          ],
        } as never,
      });

      expect(flipCall()).toBeDefined();
      expect(forensicsCall()?.values[0]).toEqual(['results-only term']);
      expect(forensicsCall()?.values[1]).toEqual(['explicit']);
    });
  });

  describe('missing label telemetry', () => {
    // A label the scanner never answers must not read as a clean 0% rate. Logged
    // unconditionally, ahead of the verdict early return: the shadow phase needs this signal on
    // every callback, not only the ones that also happened to trigger.
    it('logs missing requested labels, even when nothing triggered', async () => {
      await modelModerationAdapter.applyResult?.(applyArgs([]));

      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'model-text-moderation',
          message: 'requested label missing from scan results',
          modelId: 1,
          missingLabels: expect.arrayContaining(
            MODEL_MODERATION_SCAN_LABELS as unknown as string[]
          ),
        })
      );
    });

    // Negative control. Keyed on `missingLabels` being present at all rather than on a substring
    // of the message, so a copy edit to the message cannot silently retire it.
    it('does not log when every requested label answered', async () => {
      await modelModerationAdapter.applyResult?.({
        entityId: 1,
        workflowId: 'wf-1',
        blocked: false,
        triggeredLabels: [],
        output: {
          blocked: false,
          triggeredLabels: [],
          results: MODEL_MODERATION_SCAN_LABELS.map((label) => ({
            label,
            score: 0.1,
            threshold: 0.5,
            matchedTerms: { text: [], positivePrompt: [], negativePrompt: [] },
          })),
        } as never,
      });

      expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
        expect.objectContaining({ missingLabels: expect.anything() })
      );
    });
  });
});

describe('modelModerationAdapter.submit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits the full label list at low priority, recorded for review, when the flag is on', async () => {
    flags({ [SUBMIT_FLAG]: true });
    vi.mocked(submitTextModeration).mockResolvedValue({ id: 'wf-1' } as never);

    const result = await modelModerationAdapter.submit({ entityId: 5, content: 'some text' });

    expect(isFlipt).toHaveBeenCalledWith(SUBMIT_FLAG, '5');
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

  // Off must mean "no scan is requested at all", including from the retry cron, which reaches
  // this hook directly rather than through submitModelTextModeration.
  it('does not submit when the flag is off', async () => {
    flags({ [SUBMIT_FLAG]: false });

    const result = await modelModerationAdapter.submit({ entityId: 5, content: 'some text' });

    expect(submitTextModeration).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  // The cron asks this BEFORE it spends a retry. A declined submit is indistinguishable from a
  // failed one, so without the hook a dark feature burns every row's whole retry budget and
  // those rows are then never picked up again — including after the flag comes back on.
  it('reports whether moderation is enabled so the retry cron can skip dark rows', async () => {
    flags({ [SUBMIT_FLAG]: false });
    expect(await modelModerationAdapter.isEnabled?.({ entityId: 5 })).toBe(false);

    flags({ [SUBMIT_FLAG]: true });
    expect(await modelModerationAdapter.isEnabled?.({ entityId: 5 })).toBe(true);
  });
});

// Delete the registry line and every callback finds no adapter — the whole feature goes dark
// with nothing else to notice, because every test above reaches the adapter object directly.
describe('adapter registration', () => {
  it('is registered under the Model entityType', () => {
    expect(getModerationAdapter('Model')).toBe(modelModerationAdapter);
  });
});

// The drift this guards is silent: dedup stops hitting and nothing errors.
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

  // The submit sends 15 labels; only 3 may act. A Review/Block label triggering must not flip
  // nsfw — that is the difference between this and honouring `output.blocked`.
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

  // `triggeredLabels` and `results[]` are two views of the same fact across a network boundary;
  // a level label present in only one view must still count.
  it('triggers on results[].triggered === true even when absent from triggeredLabels', () => {
    expect(
      isModelTextNsfw({
        triggeredLabels: [],
        results: [{ label: 'Explicit', score: 0.9, threshold: 0.5, triggered: true } as never],
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

  // The boundary itself. `>=` vs `>` is a one-character revert that every other score fixture
  // here is too far from the threshold to catch.
  it('triggers when the score exactly equals the threshold', () => {
    expect(
      isModelTextNsfw({
        triggeredLabels: [],
        results: [{ label: 'Suggestive', score: 0.5, threshold: 0.5 } as never],
      })
    ).toBe(true);
  });

  // The producer scores an unreadable blob as 0, so a `threshold: 0` label would satisfy
  // `0 >= 0` and flip a model off a scan that answered nothing.
  it('does not trigger on a zero score against a zero threshold', () => {
    expect(
      isModelTextNsfw({
        triggeredLabels: [],
        results: [{ label: 'NSFW', score: 0, threshold: 0 } as never],
      })
    ).toBe(false);
  });

  // An errored label arrives looking exactly like a clean one — score 0, triggered false — so
  // a populated `error` has to be excluded explicitly rather than relied on to score low.
  it('does not trigger on a label the scanner errored on', () => {
    expect(
      isModelTextNsfw({
        triggeredLabels: [],
        results: [
          {
            label: 'Explicit',
            score: 0.9,
            threshold: 0.5,
            triggered: true,
            error: 'Step output was missing.',
          } as never,
        ],
      })
    ).toBe(false);
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
  // strings, and a silent drift here is invisible everywhere else.
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

// Every branch here loses rows SILENTLY when wrong — the sweep reports success and simply
// never visits the skipped ids. Measured against dev while walking the real table: window
// 50k with limit 200 truncates from the second page on, so the truncated branch is the
// common case, not the edge one.
describe('resolveBackfillCursor', () => {
  it('resumes at the last candidate when the window filled its limit', () => {
    expect(
      resolveBackfillCursor({
        windowEnd: 100_000,
        maxId: 2_862_887,
        lastCandidateId: 84_129,
        truncated: true,
      })
    ).toBe(84_129);
  });

  it('advances by the whole window when the window was drained', () => {
    expect(
      resolveBackfillCursor({
        windowEnd: 50_000,
        maxId: 2_862_887,
        lastCandidateId: 49_998,
        truncated: false,
      })
    ).toBe(50_000);
  });

  // A window that matched nothing still made progress; stalling here would loop forever.
  it('advances past a window that matched nothing', () => {
    expect(
      resolveBackfillCursor({ windowEnd: 50_000, maxId: 2_862_887, truncated: false })
    ).toBe(50_000);
  });

  it('terminates once the window reaches past the last id', () => {
    expect(
      resolveBackfillCursor({ windowEnd: 2_900_000, maxId: 2_862_887, truncated: false })
    ).toBeNull();
  });

  // Truncation wins over termination: a full last window still has undrained rows behind it.
  it('does not terminate on a truncated final window', () => {
    expect(
      resolveBackfillCursor({
        windowEnd: 2_900_000,
        maxId: 2_862_887,
        lastCandidateId: 2_861_000,
        truncated: true,
      })
    ).toBe(2_861_000);
  });

  // Truncated with no candidate is contradictory, but the guard has to hold rather than
  // return undefined and stall the sweep on a NaN cursor.
  it('falls back to the window end when truncated with no candidate id', () => {
    expect(
      resolveBackfillCursor({ windowEnd: 50_000, maxId: 2_862_887, truncated: true })
    ).toBe(50_000);
  });
});
