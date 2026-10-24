import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type { RuleDefinition } from '~/server/utils/mod-rules';
import { evaluateRule, evaluateRules, ruleDefinitionSchema } from '~/server/utils/mod-rules';

const rules = {
  // The shape every stored image rule has: an `or` of word-boundary regexes against the prompt.
  wordOr: {
    type: 'or',
    rules: [
      { type: 'content', target: ['prompt'], match: '/(?:\\b|\\s)Word(?:\\b|\\s)/gmi' },
      {
        type: 'content',
        target: ['prompt'],
        match: '/(?:\\b|\\s)Other[\\s\\-_]*Name(?:\\b|\\s)/gmi',
      },
    ],
  },
  bareString: { type: 'content', target: ['prompt', 'name'], match: 'robot' },
  noFlags: { type: 'content', target: ['name'], match: '/Cat/' },
  tagAny: { type: 'tag', tags: ['nsfw', 'gore'], match: 'any' },
  tagAll: { type: 'tag', tags: ['nsfw', 'gore'], match: 'all' },
  andContentTag: {
    type: 'and',
    rules: [
      { type: 'content', target: ['prompt'], match: '/adult/i' },
      { type: 'tag', tags: ['nsfw'], match: 'any' },
    ],
  },
  emptyOr: { type: 'or', rules: [] },
  emptyAnd: { type: 'and', rules: [] },
  nested: {
    type: 'or',
    rules: [
      {
        type: 'and',
        rules: [
          { type: 'tag', tags: ['gore'], match: 'any' },
          { type: 'content', target: ['description'], match: 'x' },
        ],
      },
      { type: 'content', target: ['prompt'], match: '/^swordfish$/' },
    ],
  },
} satisfies Record<string, RuleDefinition>;

const objects = {
  word: { prompt: 'a Word here', tags: [] },
  wordInside: { prompt: 'Swordfish', tags: ['nsfw'] },
  robotCat: { prompt: 'robot cat', name: 'Cat', tags: ['nsfw', 'gore'] },
  missing: {},
  adult: { prompt: 'Adult content', tags: ['nsfw'] },
  otherName: { prompt: 'by other-name.', description: 'x', tags: ['gore'] },
};

// Results of the evaluator before rules were limited to content/tag/and/or, run over the same table.
const expected: Record<keyof typeof rules, Record<keyof typeof objects, boolean>> = {
  wordOr: {
    word: true,
    wordInside: false,
    robotCat: false,
    missing: false,
    adult: false,
    otherName: true,
  },
  bareString: {
    word: false,
    wordInside: false,
    robotCat: true,
    missing: false,
    adult: false,
    otherName: false,
  },
  noFlags: {
    word: false,
    wordInside: false,
    robotCat: true,
    missing: false,
    adult: false,
    otherName: false,
  },
  tagAny: {
    word: false,
    wordInside: true,
    robotCat: true,
    missing: false,
    adult: true,
    otherName: true,
  },
  tagAll: {
    word: false,
    wordInside: false,
    robotCat: true,
    missing: false,
    adult: false,
    otherName: false,
  },
  andContentTag: {
    word: false,
    wordInside: false,
    robotCat: false,
    missing: false,
    adult: true,
    otherName: false,
  },
  emptyOr: {
    word: false,
    wordInside: false,
    robotCat: false,
    missing: false,
    adult: false,
    otherName: false,
  },
  emptyAnd: {
    word: true,
    wordInside: true,
    robotCat: true,
    missing: true,
    adult: true,
    otherName: true,
  },
  nested: {
    word: false,
    wordInside: false,
    robotCat: false,
    missing: false,
    adult: false,
    otherName: true,
  },
};

const propertyRule = {
  type: 'property',
  condition: '(globalThis.__modRuleConditionRan = true)',
} as unknown as RuleDefinition;

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as { __modRuleConditionRan?: boolean }).__modRuleConditionRan;
});

describe('evaluateRule', () => {
  const cases = Object.entries(expected).flatMap(([rule, byObject]) =>
    Object.entries(byObject).map(([object, result]) => [rule, object, result] as const)
  );

  it.each(cases)('%s against %s -> %s', (rule, object, result) => {
    expect(
      evaluateRule(rules[rule as keyof typeof rules], objects[object as keyof typeof objects])
    ).toBe(result);
  });

  it('never matches a property rule, and never runs its condition', () => {
    const inOr = { type: 'or', rules: [propertyRule] } as RuleDefinition;

    expect(evaluateRule(propertyRule, objects.word)).toBe(false);
    expect(evaluateRule(inOr, objects.word)).toBe(false);
    expect(
      (globalThis as { __modRuleConditionRan?: boolean }).__modRuleConditionRan
    ).toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'moderation-rule', type: 'error', ruleType: 'property' })
    );
  });

  it('skips a property rule and applies the next rule that matches', () => {
    const applied = evaluateRules(
      [
        { id: 1, definition: propertyRule, action: 'Block' },
        { id: 2, definition: rules.wordOr, action: 'Block' },
      ],
      objects.word
    );
    expect(applied?.id).toBe(2);
  });
});

describe('ruleDefinitionSchema', () => {
  it.each(Object.entries(rules))('accepts %s', (_, rule) => {
    expect(ruleDefinitionSchema.safeParse(rule).success).toBe(true);
  });

  it('rejects a property rule at any depth', () => {
    expect(ruleDefinitionSchema.safeParse(propertyRule).success).toBe(false);
    const nested = { type: 'and', rules: [rules.tagAny, { type: 'or', rules: [propertyRule] }] };
    expect(ruleDefinitionSchema.safeParse(nested).success).toBe(false);
  });
});
