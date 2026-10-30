import { describe, expect, test } from 'vitest';
import { storylinePublishMessage } from '~/components/Storyline/editor/storyline-publish-message';
import { NsfwLevel } from '~/server/common/enums';

const base = { storylineId: 3 };

describe('storylinePublishMessage', () => {
  test('a written chapter is live', () => {
    expect(storylinePublishMessage({ ...base, status: 'chapterWritten', chapterId: 1 })).toEqual({
      message: 'Chapter 1 is live.',
      color: 'teal',
    });
  });

  test('a raised ceiling says which rating it was raised to', () => {
    const { message, color } = storylinePublishMessage({
      ...base,
      status: 'chapterWritten',
      chapterId: 1,
      ceilingRaisedTo: NsfwLevel.R,
    });
    expect(message).toContain("Your storyline's maximum rating was raised to R to fit chapter 1");
    expect(color).toBe('teal');
  });

  test('a chapter waiting on the image scan goes live when the images finish checking', () => {
    expect(storylinePublishMessage({ ...base, status: 'waiting', reason: 'notReady' })).toEqual({
      message: 'Chapter 1 goes live once your images finish checking.',
      color: 'yellow',
    });
  });

  test('a restricted account has it added when the account is able to', () => {
    expect(
      storylinePublishMessage({ ...base, status: 'waiting', reason: 'restricted' }).message
    ).toBe('Chapter 1 will be added when your account is able to.');
  });

  test('a chapter above the ceiling and one that cannot be added each say so', () => {
    expect(
      storylinePublishMessage({ ...base, status: 'waiting', reason: 'aboveRating' }).message
    ).toMatch(/above your storyline's maximum rating/);
    expect(
      storylinePublishMessage({ ...base, status: 'waiting', reason: 'cannotSubmit' }).message
    ).toMatch(/can't be added/);
  });

  test('a chapter above the ceiling names both ratings', () => {
    expect(
      storylinePublishMessage({
        ...base,
        status: 'waiting',
        reason: 'aboveRating',
        rating: { postLevel: NsfwLevel.R, maxNsfwLevel: NsfwLevel.PG13 },
      }).message
    ).toContain('Your storyline allows up to PG-13; this post is R.');
  });

  test("a dropped link shows the server's reason, as a problem", () => {
    expect(
      storylinePublishMessage({
        ...base,
        status: 'dropped',
        reason: 'This storyline was taken down',
      })
    ).toEqual({ message: 'This storyline was taken down', color: 'red' });
  });

  test('the chapter number follows the chapter written', () => {
    expect(
      storylinePublishMessage(
        { ...base, status: 'waiting', reason: 'notReady' },
        { chapterNumber: 4 }
      ).message
    ).toBe('Chapter 4 goes live once your images finish checking.');
  });
});
