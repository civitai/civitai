import { describe, expect, it } from 'vitest';
import {
  articleUnpublishReasons,
  getArticleUnpublishReason,
  legacyArticleUnpublishReasons,
  unpublishReasons,
} from '~/server/common/moderation-helpers';
import { articleUnpublishNotifications } from '~/server/notifications/article-unpublish.notifications';

type Def = (typeof articleUnpublishNotifications)['article-unpublished'];
const def = (articleUnpublishNotifications as Record<string, Def>)['article-unpublished'];

const prepare = (details: MixedObject) =>
  def.prepareMessage({ type: 'article-unpublished', details } as Parameters<
    Def['prepareMessage']
  >[0]);

// Model vocabulary an article's author has no referent for — a support ticket had one told to fix
// their "resource" and tag their "model" when they had neither.
const MODEL_WORDS = /\b(model|models|resource|resources|version|versions|example images)\b/i;

describe('articleUnpublishReasons', () => {
  it('speaks about articles, never models or resources', () => {
    const offenders = Object.entries({
      ...articleUnpublishReasons,
      ...legacyArticleUnpublishReasons,
    })
      .filter(([, { notificationMessage }]) => MODEL_WORDS.test(notificationMessage))
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });

  it('offers no reason that describes an uploaded resource', () => {
    const modelOnly = ['no-posts', 'no-versions', 'no-files', 'nudify', 'non-generated-image'];

    for (const key of modelOnly) expect(articleUnpublishReasons).not.toHaveProperty(key);
  });

  it('reuses the model reason keys so stored metadata stays readable by both lists', () => {
    for (const key of [
      ...Object.keys(articleUnpublishReasons),
      ...Object.keys(legacyArticleUnpublishReasons),
    ])
      expect(unpublishReasons).toHaveProperty(key);
  });
});

describe('getArticleUnpublishReason', () => {
  it('does not call a quality take-down a Terms of Service violation', () => {
    expect(getArticleUnpublishReason('insufficient-description')?.type).toBe('quality');
    expect(getArticleUnpublishReason('duplicate')?.type).toBe('quality');
  });

  it('still calls a policy take-down what it is', () => {
    expect(getArticleUnpublishReason('spam')?.type).toBe('policy');
    expect(getArticleUnpublishReason('mature-underage')?.type).toBe('policy');
  });

  // Both keys are still stored on live articles (2026-09-02: 6 `unintenteded-use`, 1 `no-posts`), so neither entry is dead.
  it('resolves a reason stored on live articles without borrowing the model copy', () => {
    for (const key of ['unintenteded-use', 'no-posts']) {
      const detail = getArticleUnpublishReason(key);

      expect(detail?.notificationMessage).toBeTruthy();
      expect(detail?.notificationMessage).not.toBe(
        unpublishReasons[key as keyof typeof unpublishReasons].notificationMessage
      );
      expect(detail?.notificationMessage).not.toMatch(MODEL_WORDS);
    }
  });

  it('returns nothing for a reason that was never a reason', () => {
    expect(getArticleUnpublishReason('not-a-reason')).toBeUndefined();
  });

  it('does not resolve a reason off Object.prototype', () => {
    for (const inherited of ['toString', 'constructor', 'hasOwnProperty'])
      expect(getArticleUnpublishReason(inherited)).toBeUndefined();
  });
});

describe('article-unpublished notification', () => {
  it('sends the article wording, not the model wording', () => {
    const message = prepare({
      articleId: 1,
      articleTitle: 'How I fixed a bug',
      reason: 'insufficient-description',
    })!.message;

    expect(message).toContain(
      articleUnpublishReasons['insufficient-description'].notificationMessage
    );
    expect(message).not.toMatch(MODEL_WORDS);
  });

  it('does not blank out a legacy reason the picker no longer offers', () => {
    const message = prepare({
      articleId: 1,
      articleTitle: 'How I fixed a bug',
      reason: 'no-posts',
    })!.message;

    expect(message).toContain(legacyArticleUnpublishReasons['no-posts'].notificationMessage);
    expect(message).not.toMatch(MODEL_WORDS);
  });

  it('does not trail a colon when it has no copy for the reason', () => {
    const message = prepare({
      articleId: 1,
      articleTitle: 'How I fixed a bug',
      reason: 'not-a-reason',
    })!.message;

    expect(message).toBe('Your article "How I fixed a bug" has been unpublished.');
  });
});
