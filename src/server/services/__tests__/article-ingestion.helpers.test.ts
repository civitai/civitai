import { describe, expect, it } from 'vitest';
import type { ArticleIngestionInputs } from '~/server/services/article-ingestion.helpers';
import {
  deriveArticleIngestionState,
  ingestionErrorPatch,
  ingestionErrorStep,
  savedArticleMetadata,
  type ArticleIngestionErrorState,
  textCheckSpentRetries,
} from '~/server/services/article-ingestion.helpers';
import { TEXT_MODERATION_RETRY_LIMIT } from '~/server/jobs/text-moderation-retry.constants';
import { ArticleIngestionStatus, EntityModerationStatus } from '~/shared/utils/prisma/enums';

// A fully-scanned, clean, no-override article. Each test overrides only the
// fields relevant to the case it asserts.
const base: ArticleIngestionInputs = {
  imageBlocked: false,
  imageError: false,
  imageDone: true,
  textBlocked: false,
  textError: false,
  textDone: true,
  hasModeratorOverride: false,
};

describe('deriveArticleIngestionState', () => {
  describe('moderator NSFW override in force', () => {
    it('resolves Scanned when a content image errored (the unscannable animated-webp bug)', () => {
      expect(
        deriveArticleIngestionState({
          ...base,
          hasModeratorOverride: true,
          imageError: true,
          imageDone: true,
        })
      ).toBe(ArticleIngestionStatus.Scanned);
    });

    it('resolves Scanned while a content image is still Pending (not yet done)', () => {
      expect(
        deriveArticleIngestionState({
          ...base,
          hasModeratorOverride: true,
          imageDone: false,
        })
      ).toBe(ArticleIngestionStatus.Scanned);
    });

    it('resolves Scanned when text moderation errored', () => {
      expect(
        deriveArticleIngestionState({
          ...base,
          hasModeratorOverride: true,
          textError: true,
        })
      ).toBe(ArticleIngestionStatus.Scanned);
    });

    it('still resolves Blocked when a content image is policy-blocked (override is not a moderation bypass)', () => {
      expect(
        deriveArticleIngestionState({
          ...base,
          hasModeratorOverride: true,
          imageBlocked: true,
        })
      ).toBe(ArticleIngestionStatus.Blocked);
    });

    it('still resolves Blocked when text is policy-blocked', () => {
      expect(
        deriveArticleIngestionState({
          ...base,
          hasModeratorOverride: true,
          textBlocked: true,
        })
      ).toBe(ArticleIngestionStatus.Blocked);
    });

    it('resolves Scanned for a clean, fully-scanned article', () => {
      expect(deriveArticleIngestionState({ ...base, hasModeratorOverride: true })).toBe(
        ArticleIngestionStatus.Scanned
      );
    });
  });

  describe('no override (default path unchanged)', () => {
    it('resolves Error when a content image errored', () => {
      expect(deriveArticleIngestionState({ ...base, imageError: true })).toBe(
        ArticleIngestionStatus.Error
      );
    });

    it('resolves Error when text moderation errored', () => {
      expect(deriveArticleIngestionState({ ...base, textError: true })).toBe(
        ArticleIngestionStatus.Error
      );
    });

    it('resolves Blocked when a content image is policy-blocked', () => {
      expect(deriveArticleIngestionState({ ...base, imageBlocked: true })).toBe(
        ArticleIngestionStatus.Blocked
      );
    });

    it('resolves Blocked when an image is BOTH blocked and errored (Blocked beats Error — locks line order guarding the CSAM guard)', () => {
      expect(deriveArticleIngestionState({ ...base, imageBlocked: true, imageError: true })).toBe(
        ArticleIngestionStatus.Blocked
      );
    });

    it('resolves Pending while images are not yet all terminal', () => {
      expect(deriveArticleIngestionState({ ...base, imageDone: false })).toBe(
        ArticleIngestionStatus.Pending
      );
    });

    it('resolves Pending while text moderation is still outstanding', () => {
      expect(deriveArticleIngestionState({ ...base, textDone: false })).toBe(
        ArticleIngestionStatus.Pending
      );
    });

    it('resolves Scanned when everything is terminal and clean', () => {
      expect(deriveArticleIngestionState(base)).toBe(ArticleIngestionStatus.Scanned);
    });
  });
});

// Rounds at about 1, 3 and 7 days, agreed with the Moderation Lead (#10522).
describe('ingestionErrorStep, the Error retry schedule', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const enteredAt = Date.UTC(2026, 10, 1);
  const at = (days: number) => enteredAt + days * DAY;

  it('starts an episode the reconcile job finds unrecorded', () => {
    expect(ingestionErrorStep(null, at(0))).toBe('start');
  });

  it.each([
    [0, 0.9, 'wait'],
    [0, 1, 'round'],
    [1, 2.9, 'wait'],
    [1, 3, 'round'],
    [2, 6.9, 'wait'],
    [2, 7, 'round'],
  ] as const)('after %i round(s), on day %d: %s', (rounds, day, step) => {
    expect(ingestionErrorStep({ enteredAt, rounds, checkedAt: at(day) }, at(day))).toBe(step);
  });

  it("marks the episode exhausted a day after the last round, giving that round's scans time to return", () => {
    const last = { enteredAt, rounds: 3, lastRoundAt: at(7), checkedAt: at(7) };
    expect(ingestionErrorStep(last, at(7.5))).toBe('wait');
    expect(ingestionErrorStep(last, at(8))).toBe('exhaust');
  });

  it('looks again once a day, after the retries too, since a lifted hold recomputes nothing', () => {
    const exhausted = { enteredAt, rounds: 3, exhaustedAt: at(8), checkedAt: at(8) };
    expect(ingestionErrorStep(exhausted, at(8.5))).toBe('wait');
    expect(ingestionErrorStep(exhausted, at(9))).toBe('check');
    expect(ingestionErrorStep({ enteredAt, rounds: 1, checkedAt: at(1) }, at(2))).toBe('check');
  });
});

describe('an Error episode run through the reconcile job, tick by tick', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const TICK = 10 * 60 * 1000;
  const enteredAt = Date.UTC(2026, 10, 1);

  // What the job does to an episode that stays at Error for two weeks.
  const simulate = () => {
    let state: ArticleIngestionErrorState = { enteredAt, rounds: 0 };
    const acted: { step: string; day: number }[] = [];
    for (let now = enteredAt; now <= enteredAt + 14 * DAY; now += TICK) {
      const step = ingestionErrorStep(state, now);
      if (step === 'wait' || step === 'start') continue;
      state = { ...state, ...ingestionErrorPatch(step, state, now) };
      acted.push({ step, day: Math.floor((now - enteredAt) / DAY) });
    }
    return acted;
  };

  it('runs a round on days 1, 3 and 7, exhausts once on day 8, and checks daily after', () => {
    const acted = simulate();
    expect(acted.filter(({ step }) => step === 'round').map(({ day }) => day)).toEqual([1, 3, 7]);
    expect(acted.filter(({ step }) => step === 'exhaust').map(({ day }) => day)).toEqual([8]);
    const checks = acted.filter(({ step }) => step === 'check').map(({ day }) => day);
    expect(checks).toEqual([2, 4, 5, 6, 9, 10, 11, 12, 13, 14]);
  });
});

describe('savedArticleMetadata, the metadata an author save writes', () => {
  const episode = { enteredAt: 5, rounds: 2, notifiedAt: 6 };
  const save = (
    stored: Record<string, unknown>,
    sent: Record<string, unknown>,
    ingestion: ArticleIngestionStatus
  ) => savedArticleMetadata({ stored, sent, ingestion, now: 99 });

  it('keeps the stored episode, whatever the client sent', () => {
    expect(
      save(
        { ingestionError: episode, theme: 'a' },
        { ingestionError: { bogus: true }, theme: 'b' },
        ArticleIngestionStatus.Rescan
      )
    ).toEqual({ ingestionError: episode, theme: 'b' });
  });

  it('records a silent episode for an article at Error without one, so the save keeps the hold', () => {
    expect(save({}, { ingestionError: episode }, ArticleIngestionStatus.Error)).toEqual({
      ingestionError: { enteredAt: 99, rounds: 0, silent: true },
    });
  });

  it('records none for an article that is not at Error, and drops a sent one', () => {
    expect(
      save({ theme: 'a' }, { ingestionError: episode }, ArticleIngestionStatus.Scanned)
    ).toEqual({ theme: 'a' });
  });
});

describe('textCheckSpentRetries', () => {
  const spent = TEXT_MODERATION_RETRY_LIMIT;

  it('sends a failed check again once the retry job has given up on it', () => {
    expect(
      textCheckSpentRetries({ status: EntityModerationStatus.Failed, retryCount: spent })
    ).toBe(true);
  });

  it('leaves a failed check the retry job is still retrying', () => {
    expect(
      textCheckSpentRetries({ status: EntityModerationStatus.Failed, retryCount: spent - 1 })
    ).toBe(false);
  });

  it('never sends a check that succeeded again', () => {
    expect(
      textCheckSpentRetries({ status: EntityModerationStatus.Succeeded, retryCount: spent })
    ).toBe(false);
  });
});
