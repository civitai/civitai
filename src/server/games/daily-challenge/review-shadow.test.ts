import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { reviewWithShadow, shadowFor, shadowSendable } from './review-shadow';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import { NsfwLevel } from '~/server/common/enums';

const { logToAxiom } = loggingMock;

const review = (summary: string, model = 'xiaomi/mimo-v2.5') => ({
  score: { theme: 7, wittiness: 5, humor: 4, aesthetic: 8 },
  reaction: 'Like' as const,
  comment: `comment ${summary}`,
  summary,
  model,
});
const context = { challengeId: 1, imageId: 2, nsfwLevel: 1 };
const loggedEvent = async () => {
  await vi.waitFor(() => expect(logToAxiom).toHaveBeenCalledTimes(1));
  return logToAxiom.mock.calls[0][0];
};

describe('reviewWithShadow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the primary review and logs both models side by side', async () => {
    const run = vi.fn(async (model?: string) =>
      model ? review('shadow', model) : review('primary')
    );

    const result = await reviewWithShadow({
      run,
      shadow: { model: 'civitai/qwen3.8', sampleRate: 1 },
      context,
    });

    expect(result.summary).toBe('primary');
    expect(run).toHaveBeenCalledWith('civitai/qwen3.8', undefined);
    const event = await loggedEvent();
    expect(event).toMatchObject({
      type: 'daily-challenge-review-shadow',
      ...context,
      primary: { ok: true, model: 'xiaomi/mimo-v2.5', summary: 'primary' },
      shadow: { ok: true, model: 'civitai/qwen3.8', summary: 'shadow' },
    });
  });

  it('keeps the primary review when the shadow model fails', async () => {
    const run = vi.fn(async (model?: string) => {
      if (model) throw new Error('Civitai LLM error 503');
      return review('primary');
    });

    const result = await reviewWithShadow({
      run,
      shadow: { model: 'civitai/qwen3.8', sampleRate: 1 },
      context,
    });

    expect(result.summary).toBe('primary');
    const event = await loggedEvent();
    expect(event.shadow).toMatchObject({ ok: false, error: 'Civitai LLM error 503' });
  });

  it('still throws a primary failure, and logs the shadow result for that entry', async () => {
    const run = vi.fn(async (model?: string) => {
      if (!model) throw new Error('OpenRouter 429');
      return review('shadow');
    });

    await expect(
      reviewWithShadow({ run, shadow: { model: 'civitai/qwen3.8', sampleRate: 1 }, context })
    ).rejects.toThrow('OpenRouter 429');
    const event = await loggedEvent();
    expect(event.primary).toMatchObject({ ok: false, error: 'OpenRouter 429' });
    expect(event.shadow).toMatchObject({ ok: true, summary: 'shadow' });
  });

  it.each([null, { model: 'civitai/qwen3.8', sampleRate: 0 }])(
    'runs only the primary model when the shadow is %o',
    async (shadow) => {
      const run = vi.fn(async () => review('primary'));

      await reviewWithShadow({ run, shadow, context });

      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(undefined);
      expect(logToAxiom).not.toHaveBeenCalled();
    }
  );
});

describe('reviewWithShadow provider', () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the shadow's provider pin to the shadow run only", async () => {
    const provider = {
      order: ['wafer/us'],
      allowFallbacks: false,
      dataCollection: 'deny' as const,
    };
    const run = vi.fn(async (model?: string) =>
      model ? review('shadow', model) : review('primary')
    );

    await reviewWithShadow({ run, shadow: { model: 'm', sampleRate: 1, provider }, context });
    await loggedEvent();

    expect(run).toHaveBeenCalledWith(undefined);
    expect(run).toHaveBeenCalledWith('m', provider);
  });
});

// The send rules are in docs/features/challenge-platform.md §5, Judge-model shadow.
describe('shadowSendable', () => {
  const sendable = {
    source: ChallengeSource.System,
    allowedNsfwLevel: NsfwLevel.PG | NsfwLevel.PG13,
    entry: { nsfwLevel: NsfwLevel.PG13, ingestion: 'Scanned', blockedFor: null, needsReview: null },
  };

  it('sends a scanned SFW entry of an SFW System daily', () => {
    expect(shadowSendable(sendable)).toBe(true);
  });

  // Source, challenge level, scan, hold and mature entries are covered through the job in
  // daily-challenge-processing.banned-entrants.pglite.test.ts; these are the rows it cannot reach.
  it.each([
    ['an entry with no scan state', { ...sendable, entry: { nsfwLevel: NsfwLevel.PG } }],
    [
      'an entry with no block state',
      {
        ...sendable,
        entry: { nsfwLevel: NsfwLevel.PG13, ingestion: 'Scanned', needsReview: null },
      },
    ],
    [
      'an entry with no review state',
      { ...sendable, entry: { nsfwLevel: NsfwLevel.PG13, ingestion: 'Scanned', blockedFor: null } },
    ],
    ['a blocked entry', { ...sendable, entry: { ...sendable.entry, blockedFor: 'tos' } }],
    ['an unrated entry', { ...sendable, entry: { ...sendable.entry, nsfwLevel: 0 } }],
  ])('never sends %s', (_, input) => {
    expect(shadowSendable(input)).toBe(false);
  });
});

describe('shadowFor', () => {
  const input = {
    source: ChallengeSource.System,
    allowedNsfwLevel: NsfwLevel.PG | NsfwLevel.PG13,
    entry: { nsfwLevel: NsfwLevel.PG, ingestion: 'Scanned', blockedFor: null, needsReview: null },
  };
  const deny = { order: ['wafer/us'], allowFallbacks: false, dataCollection: 'deny' as const };

  it('runs a pinned shadow that denies data collection on a sendable entry', () => {
    const shadow = { model: 'm', sampleRate: 1, provider: deny };
    expect(shadowFor(shadow, input)).toBe(shadow);
  });

  // No pin, and an unsendable entry, are covered through the job in the banned-entrants PGlite suite.
  it('never runs with a pin that allows data collection', () => {
    const shadow = {
      model: 'm',
      sampleRate: 1,
      provider: { ...deny, dataCollection: 'allow' as const },
    };
    expect(shadowFor(shadow, input)).toBeNull();
  });
});
