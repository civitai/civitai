import { describe, expect, it } from 'vitest';
import { getUserNsfwLevelSubmit } from '~/components/Article/article-nsfw-submit';
import { NsfwLevel } from '~/server/common/enums';
import { upsertArticleInput } from '~/server/schema/article.schema';

// What the form sends must pass the server schema, or the save fails before it reaches the service.
const parse = (userNsfwLevel: number | undefined) =>
  upsertArticleInput.safeParse({
    title: 'Title',
    content: '<p>Body</p>',
    userNsfwLevel,
  });

describe('getUserNsfwLevelSubmit', () => {
  it('an unset level saves at the schema default (PG)', () => {
    const result = parse(getUserNsfwLevelSubmit(undefined, true));
    expect(result.success).toBe(true);
    expect(result.data?.userNsfwLevel).toBe(NsfwLevel.PG);
  });

  it('an empty select saves at the schema default (PG)', () => {
    const result = parse(getUserNsfwLevelSubmit('', true));
    expect(result.success).toBe(true);
    expect(result.data?.userNsfwLevel).toBe(NsfwLevel.PG);
  });

  it('a chosen level is sent as its number', () => {
    const result = parse(getUserNsfwLevelSubmit(String(NsfwLevel.X), true));
    expect(result.success).toBe(true);
    expect(result.data?.userNsfwLevel).toBe(NsfwLevel.X);
  });

  it('a locked level is not sent', () => {
    expect(getUserNsfwLevelSubmit(String(NsfwLevel.X), false)).toBeUndefined();
  });
});
