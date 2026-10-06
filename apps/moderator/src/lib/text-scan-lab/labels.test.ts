import { describe, expect, it } from 'vitest';
import {
  ENTITY_TYPE_NAMES,
  checkExpected,
  describeExpected,
  describeVerdict,
  promptKeyName,
} from './labels';
import { LAB_ENTITY_TYPES, PROMPT_KEYS } from './types';

const ok = (output: Record<string, unknown>) => ({ ok: true as const, output });

describe('friendly names', () => {
  it('names every prompt key', () => {
    expect(PROMPT_KEYS.map(promptKeyName)).toEqual([
      'General instructions',
      'Rating definition',
      'Real person definition',
      'Minor definition',
      'Scam / phishing definition',
    ]);
  });

  it('names every entity type', () => {
    for (const type of LAB_ENTITY_TYPES) expect(ENTITY_TYPE_NAMES[type]).toBeTruthy();
  });
});

describe('describeVerdict', () => {
  it.each([
    ['none', 'Rated PG', 'clear'],
    ['pg13', 'Rated PG-13', 'caution'],
    ['r', 'Rated R', 'flagged'],
    ['xxx', 'Rated XXX', 'flagged'],
  ])('rates nsfw %s', (level, headline, tone) => {
    expect(describeVerdict('nsfw', ok({ nsfw: { level, reason: ' because ' } }))).toEqual({
      headline,
      tone,
      reason: 'because',
    });
  });

  it('phrases flags both ways', () => {
    expect(describeVerdict('scam', ok({ scam: { detected: false, reason: 'r' } }))).toEqual({
      headline: 'Not a scam',
      tone: 'clear',
      reason: 'r',
    });
    expect(describeVerdict('scam', ok({ scam: { detected: true } })).headline).toBe('Scam');
    expect(describeVerdict('minor', ok({ minor: { detected: true } })).headline).toBe(
      'Involves a minor'
    );
  });

  it('names the real people found', () => {
    expect(
      describeVerdict('poi', ok({ poi: { detected: true, names: ['A Person', 'B Person'] } }))
    ).toMatchObject({ headline: 'Names a real person: A Person, B Person', tone: 'flagged' });
    expect(describeVerdict('poi', ok({ poi: { detected: true, names: [] } })).headline).toBe(
      'Names a real person'
    );
  });

  it("says it couldn't judge, quoting the error verbatim", () => {
    expect(describeVerdict('nsfw', { ok: false, error: 'Workflow failed: boom' })).toEqual({
      headline: "Couldn't judge: Workflow failed: boom",
      tone: 'unknown',
    });
    expect(
      describeVerdict('nsfw', { ok: true, output: null, parseError: 'bad JSON' }).headline
    ).toBe("Couldn't judge: bad JSON");
    expect(describeVerdict('scam', ok({ nsfw: { level: 'r' } })).tone).toBe('unknown');
    expect(describeVerdict('nsfw', ok({ nsfw: { level: 'weird' } })).tone).toBe('unknown');
    expect(describeVerdict('scam', ok({ scam: { reason: 'no detected' } })).tone).toBe('unknown');
  });
});

describe('describeExpected', () => {
  it.each([
    [{ min: 'pg13', max: 'pg13' }, 'PG-13'],
    [{ min: 'none', max: 'pg13' }, 'PG-13 or lower'],
    [{ min: 'r', max: 'xxx' }, 'R or higher'],
    [{ min: 'pg13', max: 'x' }, 'PG-13 to X'],
    [{ min: 'none', max: 'xxx' }, 'Any rating'],
  ] as const)('phrases nsfw %o as %s', (nsfw, text) => {
    expect(describeExpected({ nsfw })).toEqual({ nsfw: text });
  });

  it('phrases flags and leaves unscored labels out', () => {
    expect(describeExpected({ poi: true, scam: false })).toEqual({
      poi: 'Names a real person',
      scam: 'Not a scam',
    });
  });
});

describe('checkExpected', () => {
  const expected = { nsfw: { min: 'none', max: 'pg13' }, scam: false } as const;

  it('says whether the verdict met the expectation', () => {
    expect(checkExpected(expected, 'nsfw', ok({ nsfw: { level: 'pg13' } }))).toEqual({
      asExpected: true,
      expected: 'PG-13 or lower',
    });
    expect(checkExpected(expected, 'nsfw', ok({ nsfw: { level: 'r' } }))).toEqual({
      asExpected: false,
      expected: 'PG-13 or lower',
    });
    expect(checkExpected(expected, 'scam', ok({ scam: { detected: true } }))).toEqual({
      asExpected: false,
      expected: 'Not a scam',
    });
  });

  it('is null for an unscored label or no usable verdict', () => {
    expect(checkExpected(expected, 'poi', ok({ poi: { detected: true } }))).toBeNull();
    expect(checkExpected(expected, 'nsfw', { ok: false, error: 'x' })).toBeNull();
    expect(checkExpected(expected, 'nsfw', ok({ nsfw: { level: 'weird' } }))).toBeNull();
  });
});
