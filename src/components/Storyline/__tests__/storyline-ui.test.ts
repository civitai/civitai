import { describe, expect, test } from 'vitest';
import {
  storylinePriceCaption,
  storylinePriceLabel,
  storylineSubmitVerdict,
} from '~/components/Storyline/storyline-ui';
import { NsfwLevel } from '~/server/common/enums';

const owner = 1;
const contributor = 2;
const story = (
  overrides: Partial<Parameters<typeof storylineSubmitVerdict>[0]['storyline']> = {}
) => ({
  userId: owner,
  status: 'Ongoing' as const,
  maxNsfwLevel: NsfwLevel.PG13,
  ...overrides,
});
const verdict = (
  overrides: Partial<Parameters<typeof storylineSubmitVerdict>[0]> = {}
): ReturnType<typeof storylineSubmitVerdict> =>
  storylineSubmitVerdict({
    postLevel: NsfwLevel.PG,
    viewerId: contributor,
    storyline: story(),
    mode: 'review',
    isCollaborator: false,
    ...overrides,
  });

describe('storylineSubmitVerdict', () => {
  test('a post at or under the ceiling may be submitted', () => {
    expect(verdict({ postLevel: NsfwLevel.PG13 })).toEqual({ allowed: true, awaitingScan: false });
  });

  test('a post above the ceiling is refused up front', () => {
    expect(verdict({ postLevel: NsfwLevel.X })).toEqual({ allowed: false, reason: 'aboveRating' });
  });

  test('a post is judged by its most severe image', () => {
    expect(verdict({ postLevel: NsfwLevel.PG | NsfwLevel.R })).toEqual({
      allowed: false,
      reason: 'aboveRating',
    });
  });

  test('an unrated post is not refused: it waits for its rating', () => {
    expect(verdict({ postLevel: 0 })).toEqual({ allowed: true, awaitingScan: true });
  });

  test('the creator cannot continue their own storyline as a contributor', () => {
    expect(verdict({ viewerId: owner })).toEqual({ allowed: false, reason: 'ownStoryline' });
  });

  test('a complete storyline takes no continuations', () => {
    expect(verdict({ storyline: story({ status: 'Complete' }) })).toEqual({
      allowed: false,
      reason: 'complete',
    });
  });

  test('collaborators-only refuses strangers and lets collaborators through', () => {
    expect(verdict({ mode: 'off' })).toEqual({ allowed: false, reason: 'collaboratorsOnly' });
    expect(verdict({ mode: 'off', isCollaborator: true })).toEqual({
      allowed: true,
      awaitingScan: false,
    });
  });

  test('a collaborator is still held to the ceiling', () => {
    expect(verdict({ isCollaborator: true, postLevel: NsfwLevel.XXX })).toEqual({
      allowed: false,
      reason: 'aboveRating',
    });
  });
});

describe('price copy', () => {
  test('zero reads as Free, anything else as Buzz', () => {
    expect(storylinePriceLabel(0)).toBe('Free');
    expect(storylinePriceLabel(1500)).toBe('1,500 Buzz');
  });

  test('the slider caption says Free at zero and warns above the cap', () => {
    expect(storylinePriceCaption(0, 500)).toEqual({ text: 'Free to continue', warning: false });
    expect(storylinePriceCaption(100, 500)).toEqual({
      text: 'Contributors pay 100 Buzz',
      warning: false,
    });
    expect(storylinePriceCaption(600, 500)).toEqual({
      text: 'Contributors pay 500 Buzz',
      warning: true,
    });
  });
});
