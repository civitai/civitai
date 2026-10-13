import { describe, expect, it } from 'vitest';
import {
  ENTITY_TYPE_NAMES,
  blankPromptKeys,
  describeBlankPrompts,
  describeVerdict,
  labRuleMatches,
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
      'Model rules definition',
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
  ])('rates nsfw %s, neutrally', (level, headline, tone) => {
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
    expect(describeVerdict('nsfw', ok({ nsfw: { level: 'constructor' } })).tone).toBe('unknown');
    expect(describeVerdict('scam', ok({ scam: { reason: 'no detected' } })).tone).toBe('unknown');
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

describe('model rules verdict', () => {
  const rules = (matched: unknown) => ok({ modelRules: { matched } });

  it('names the matched rules by subject when the run listed them, else by id', () => {
    const matched = rules([
      { ruleId: 378, reason: ' a ' },
      { ruleId: 12, reason: 'b' },
    ]);
    expect(describeVerdict('modelRules', matched)).toEqual({
      headline: 'Matched #378, #12',
      tone: 'flagged',
      reason: '#378: a\n#12: b',
    });
    expect(describeVerdict('modelRules', matched, [{ id: 378, subject: 'Example' }])).toMatchObject(
      {
        headline: 'Matched Example, #12',
      }
    );
  });

  it('counts a literal-only hit as a match', () => {
    const literal = {
      ok: true as const,
      output: { modelRules: { matched: [] } },
      literalRuleIds: [5],
    };
    expect(describeVerdict('modelRules', literal, [{ id: 5, subject: 'Named' }])).toMatchObject({
      headline: 'Matched Named',
      tone: 'flagged',
    });
    expect(labRuleMatches(literal, [{ id: 5, subject: 'Named' }])).toEqual([
      { ruleId: 5, subject: 'Named', reason: null, llm: false, literal: true },
    ]);
  });

  it('marks a rule matched both ways once, with the model reason', () => {
    const both = {
      ok: true as const,
      output: { modelRules: { matched: [{ ruleId: -1, reason: 'variant spelling' }] } },
      literalRuleIds: [-1],
    };
    expect(labRuleMatches(both, [{ id: -1, subject: 'New rule' }])).toEqual([
      { ruleId: -1, subject: 'New rule', reason: 'variant spelling', llm: true, literal: true },
    ]);
  });

  it('reads an empty match list as clear', () => {
    expect(describeVerdict('modelRules', rules([]))).toEqual({
      headline: 'No rule matched',
      tone: 'clear',
    });
  });

  it('could not judge without a matched list', () => {
    expect(describeVerdict('modelRules', ok({ modelRules: {} })).tone).toBe('unknown');
    expect(describeVerdict('modelRules', ok({})).tone).toBe('unknown');
  });

  it('still shows literal hits when the model gave no answer', () => {
    const subjects = [{ id: 5, subject: 'Named' }];
    for (const output of [{}, { modelRules: {} }, null]) {
      const verdict = describeVerdict(
        'modelRules',
        { ok: true, output, parseError: 'bad json', literalRuleIds: [5, 8] },
        subjects
      );
      expect(verdict).toEqual({
        headline: 'Literal match: Named, #8',
        tone: 'flagged',
        reason: 'The model gave no Model rules answer; these rules are named in the text.',
      });
    }
  });

  it('could not judge with neither a model answer nor a literal hit', () => {
    expect(describeVerdict('modelRules', { ok: true, output: {}, literalRuleIds: [] }).tone).toBe(
      'unknown'
    );
    expect(
      describeVerdict('modelRules', { ok: true, output: null, parseError: 'bad json' }).tone
    ).toBe('unknown');
  });

  it('differs when the matched rules differ, not the reasons', () => {
    expect(
      verdictsDiffer(
        'modelRules',
        rules([{ ruleId: 1, reason: 'x' }]),
        rules([{ ruleId: 1, reason: 'y' }])
      )
    ).toBe(false);
    expect(verdictsDiffer('modelRules', rules([{ ruleId: 1 }]), rules([{ ruleId: 2 }]))).toBe(true);
    expect(verdictsDiffer('modelRules', rules([{ ruleId: 1 }]), rules([]))).toBe(true);
  });

  it('ignores the order the model listed its matches in', () => {
    expect(
      verdictsDiffer(
        'modelRules',
        rules([{ ruleId: 1 }, { ruleId: 2 }]),
        rules([{ ruleId: 2 }, { ruleId: 1 }])
      )
    ).toBe(false);
  });

  it('differs when the model verdict on a literal hit flips', () => {
    const literal = (matched: unknown[]) => ({
      ok: true as const,
      output: { modelRules: { matched } },
      literalRuleIds: [1],
    });
    expect(verdictsDiffer('modelRules', literal([{ ruleId: 1 }]), literal([]))).toBe(true);
    expect(verdictsDiffer('modelRules', literal([{ ruleId: 1 }]), literal([{ ruleId: 1 }]))).toBe(
      false
    );
  });
});

describe('blank prompts', () => {
  it('finds blank or non-string overrides and names them', () => {
    const blank = blankPromptKeys({ base: ' \n ', 'label:scam': 'SCAM DEF', 'label:nsfw': 3 });
    expect(blank).toEqual(['base', 'label:nsfw']);
    expect(describeBlankPrompts(blank)).toBe(
      'General instructions, Rating definition are empty — write it, or reset it to current.'
    );
  });
});
