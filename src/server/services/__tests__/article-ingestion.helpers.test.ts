import { describe, expect, it } from 'vitest';
import type { ArticleIngestionInputs } from '~/server/services/article-ingestion.helpers';
import {
  deriveArticleIngestionState,
  ingestionErrorStep,
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

// Moderation Lead, 2026-11-26: rounds at about 1, 3 and 7 days, three in all.
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
    expect(ingestionErrorStep({ enteredAt, rounds }, at(day))).toBe(step);
  });

  it('stops after the third round, logging the exhaustion once', () => {
    expect(ingestionErrorStep({ enteredAt, rounds: 3 }, at(30))).toBe('exhaust');
    expect(ingestionErrorStep({ enteredAt, rounds: 3, exhaustedAt: at(8) }, at(30))).toBe('done');
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
