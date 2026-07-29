import { describe, expect, it } from 'vitest';
import type { ArticleIngestionInputs } from '~/server/services/article-ingestion.helpers';
import { deriveArticleIngestionState } from '~/server/services/article-ingestion.helpers';
import { ArticleIngestionStatus } from '~/shared/utils/prisma/enums';

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
      expect(
        deriveArticleIngestionState({ ...base, hasModeratorOverride: true })
      ).toBe(ArticleIngestionStatus.Scanned);
    });
  });

  describe('no override (default path unchanged)', () => {
    it('resolves Error when a content image errored', () => {
      expect(
        deriveArticleIngestionState({ ...base, imageError: true })
      ).toBe(ArticleIngestionStatus.Error);
    });

    it('resolves Error when text moderation errored', () => {
      expect(
        deriveArticleIngestionState({ ...base, textError: true })
      ).toBe(ArticleIngestionStatus.Error);
    });

    it('resolves Blocked when a content image is policy-blocked', () => {
      expect(
        deriveArticleIngestionState({ ...base, imageBlocked: true })
      ).toBe(ArticleIngestionStatus.Blocked);
    });

    it('resolves Blocked when an image is BOTH blocked and errored (Blocked beats Error — locks line order guarding the CSAM guard)', () => {
      expect(
        deriveArticleIngestionState({ ...base, imageBlocked: true, imageError: true })
      ).toBe(ArticleIngestionStatus.Blocked);
    });

    it('resolves Pending while images are not yet all terminal', () => {
      expect(
        deriveArticleIngestionState({ ...base, imageDone: false })
      ).toBe(ArticleIngestionStatus.Pending);
    });

    it('resolves Pending while text moderation is still outstanding', () => {
      expect(
        deriveArticleIngestionState({ ...base, textDone: false })
      ).toBe(ArticleIngestionStatus.Pending);
    });

    it('resolves Scanned when everything is terminal and clean', () => {
      expect(deriveArticleIngestionState(base)).toBe(ArticleIngestionStatus.Scanned);
    });
  });
});
