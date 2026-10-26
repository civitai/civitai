import { describe, expect, it } from 'vitest';
import { expectedFromOutput, parseExpected, scoredLabels } from './expected';

describe('parseExpected', () => {
  it('accepts a range and a range of one', () => {
    expect(parseExpected({ nsfw: { min: 'pg13', max: 'r' } }, 'Model')).toEqual({
      nsfw: { min: 'pg13', max: 'r' },
    });
    expect(parseExpected({ nsfw: { min: 'x', max: 'x' }, poi: false }, 'Model')).toEqual({
      nsfw: { min: 'x', max: 'x' },
      poi: false,
    });
  });

  it('refuses a range whose lowest level is above its highest', () => {
    expect(parseExpected({ nsfw: { min: 'x', max: 'pg13' } }, 'Model')).toMatch(/above/);
  });

  it('refuses a label the entity type does not score, naming the allowed ones', () => {
    expect(parseExpected({ scam: true }, 'Model')).toBe(
      'Model cases score nsfw, poi, minor, not scam.'
    );
  });

  it('treats an empty object as "score nothing"', () => {
    expect(parseExpected({}, 'CommentV2')).toEqual({});
  });

  it('refuses a non-object', () => {
    expect(parseExpected([], 'Model')).toBe('The expectation is malformed.');
    expect(parseExpected(null, 'Model')).toBe('The expectation is malformed.');
  });
});

describe('expectedFromOutput', () => {
  it('pins nsfw to a range of one and each flag to its verdict', () => {
    expect(
      expectedFromOutput(
        { nsfw: { level: 'r', reason: 'synthetic' }, poi: { detected: true }, minor: {} },
        ['nsfw', 'poi', 'minor']
      )
    ).toEqual({ nsfw: { min: 'r', max: 'r' }, poi: true });
  });
});

describe('scoredLabels', () => {
  it('lists the labels an expectation scores, in label order', () => {
    expect(scoredLabels({ scam: false, nsfw: { min: 'none', max: 'none' } })).toEqual([
      'nsfw',
      'scam',
    ]);
  });
});
