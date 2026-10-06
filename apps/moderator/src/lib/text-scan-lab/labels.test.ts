import { describe, expect, it } from 'vitest';
import {
  ENTITY_TYPE_NAMES,
  checkExpected,
  describeExpected,
  describeVerdict,
  promptKeyName,
  verdictsDiffer,
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
    ['none', 'Rated PG', 'neutral'],
    ['pg13', 'Rated PG-13', 'neutral'],
    ['r', 'Rated R', 'neutral'],
    ['xxx', 'Rated XXX', 'neutral'],
  ])('rates nsfw %s, neutrally without a declared level', (level, headline, tone) => {
    expect(describeVerdict('nsfw', ok({ nsfw: { level, reason: ' because ' } }))).toEqual({
      headline,
      tone,
      reason: 'because',
    });
  });

  it('flags a rating only when it is above the declared level', () => {
    const rated = (level: string) => ok({ nsfw: { level } });
    expect(describeVerdict('nsfw', rated('x'), 'r').tone).toBe('flagged');
    expect(describeVerdict('nsfw', rated('r'), 'r').tone).toBe('neutral');
    expect(describeVerdict('nsfw', rated('pg13'), 'r').tone).toBe('neutral');
    expect(describeVerdict('nsfw', rated('r'), null).tone).toBe('neutral');
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
    expect(describeVerdict('nsfw', ok({ nsfw: { level: 'constructor' } })).tone).toBe('unknown');
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

describe('verdictsDiffer', () => {
  it('compares the rating, never the reason', () => {
    const a = ok({ nsfw: { level: 'r', reason: 'one' } });
    expect(verdictsDiffer('nsfw', a, ok({ nsfw: { level: 'pg13', reason: 'one' } }))).toBe(true);
    expect(verdictsDiffer('nsfw', a, ok({ nsfw: { level: 'r', reason: 'two' } }))).toBe(false);
  });

  it("compares a flag's yes or no, never poi's names", () => {
    const named = (names: string[]) => ok({ poi: { detected: true, names } });
    expect(verdictsDiffer('poi', named(['Someone']), named(['Other']))).toBe(false);
    expect(
      verdictsDiffer('minor', ok({ minor: { detected: false } }), ok({ minor: { detected: true } }))
    ).toBe(true);
  });

  it('counts a failure against a verdict as a difference, but not two failures', () => {
    const failed = (error: string) => ({ ok: false as const, error });
    expect(verdictsDiffer('scam', failed('no'), ok({ scam: { detected: false } }))).toBe(true);
    expect(verdictsDiffer('nsfw', failed('a'), failed('b'))).toBe(false);
    expect(verdictsDiffer('scam', { ok: true, output: null, parseError: 'x' }, ok({}))).toBe(false);
  });
});
