import { describe, expect, it } from 'vitest';
import {
  articleUnpublishReasons,
  getArticleUnpublishReason,
  isArticleUnpublishReason,
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
    const offenders = Object.entries(articleUnpublishReasons)
      .filter(([, { notificationMessage }]) => MODEL_WORDS.test(notificationMessage))
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });

  it('offers no reason that describes an uploaded resource', () => {
    const modelOnly = [
      'no-posts',
      'no-versions',
      'no-files',
      'nudify',
      'non-generated-image',
      'unintenteded-use',
    ];

    for (const key of modelOnly) expect(articleUnpublishReasons).not.toHaveProperty(key);
  });

  it('reuses the model reason keys so stored metadata stays readable by both lists', () => {
    for (const key of Object.keys(articleUnpublishReasons))
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

  it('falls back to the model copy for reasons already stored on live articles', () => {
    expect(getArticleUnpublishReason('unintenteded-use')?.notificationMessage).toBe(
      unpublishReasons['unintenteded-use'].notificationMessage
    );
  });

  it('returns nothing for a reason that was never a reason', () => {
    expect(getArticleUnpublishReason('not-a-reason')).toBeUndefined();
  });

  it('does not resolve a reason off Object.prototype', () => {
    for (const inherited of ['toString', 'constructor', 'hasOwnProperty']) {
      expect(getArticleUnpublishReason(inherited)).toBeUndefined();
      expect(isArticleUnpublishReason(inherited)).toBe(false);
    }
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

  it('does not blank out a legacy reason it no longer offers', () => {
    const message = prepare({
      articleId: 1,
      articleTitle: 'How I fixed a bug',
      reason: 'unintenteded-use',
    })!.message;

    expect(message).toContain(unpublishReasons['unintenteded-use'].notificationMessage);
  });
});
