import { describe, expect, it } from 'vitest';
import { parsePlatformFeedbackVersion } from '../platform-feedback-version';

describe('parsePlatformFeedbackVersion', () => {
  it.each([
    ['2.4.0', '2.4.0'],
    ['v2.4.0', '2.4.0'],
    ['2.4', '2.4.0'],
    ['v2.4', '2.4.0'],
    ['2', '2.0.0'],
    ['v2', '2.0.0'],
    ['2.4.0-beta.1', '2.4.0-beta.1'],
    ['2.4.0+build.7', '2.4.0'],
    ['latest', null],
    ['2.4.0.1', null],
    ['2.4.x', null],
    ['', null],
  ])('%j → %j', (input, expected) => {
    expect(parsePlatformFeedbackVersion(input)).toBe(expected);
  });
});
