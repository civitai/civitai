import { describe, expect, it } from 'vitest';
import {
  MODEL_RULE_LIMITS,
  isSemanticDefinition,
  parseModelRulesStoredResult,
  semanticModelRuleSchema,
  storedModelRuleSchema,
} from './model-rules';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('semanticModelRuleSchema', () => {
  it('parses a minimal definition with defaults', () => {
    expect(semanticModelRuleSchema.parse({ type: 'semantic', subject: ' Jane Doe ' })).toEqual({
      type: 'semantic',
      subject: 'Jane Doe',
      description: '',
      aliases: [],
    });
  });

  it('rejects empty-string aliases', () => {
    expect(
      semanticModelRuleSchema.safeParse({ type: 'semantic', subject: 'Jane', aliases: [' '] })
        .success
    ).toBe(false);
  });
});

describe('isSemanticDefinition', () => {
  it('accepts a semantic definition and rejects a regex one', () => {
    expect(isSemanticDefinition({ type: 'semantic', subject: 'x' })).toBe(true);
    expect(isSemanticDefinition({ type: 'content', match: '/x/' })).toBe(false);
    expect(isSemanticDefinition(null)).toBe(false);
  });
});

describe('term word cap', () => {
  const max = MODEL_RULE_LIMITS.termWords;

  it('accepts a subject and alias at the cap and rejects one word over', () => {
    expect(
      semanticModelRuleSchema.safeParse({
        type: 'semantic',
        subject: words(max),
        aliases: [words(max)],
      }).success
    ).toBe(true);
    expect(
      semanticModelRuleSchema.safeParse({ type: 'semantic', subject: words(max + 1) }).success
    ).toBe(false);
    expect(
      semanticModelRuleSchema.safeParse({
        type: 'semantic',
        subject: 'Jane',
        aliases: [words(max + 1)],
      }).success
    ).toBe(false);
  });

  it('counts words the way the literal matcher splits them', () => {
    expect(
      semanticModelRuleSchema.safeParse({
        type: 'semantic',
        subject: 'Jane',
        aliases: ['a-b-c-d-e-f-g-h-i'],
      }).success
    ).toBe(false);
  });

  it('still reads a stored rule saved before the cap existed', () => {
    expect(
      storedModelRuleSchema.safeParse({ type: 'semantic', subject: words(max + 5) }).success
    ).toBe(true);
  });
});

describe('parseModelRulesStoredResult', () => {
  it('reads matches, snapshot, literal ids and the hold flag', () => {
    expect(
      parseModelRulesStoredResult({
        labels: { modelRules: { matched: [{ ruleId: 1, reason: ' r ' }, 'x', { ruleId: 'y' }] } },
        modelRules: {
          snapshot: [{ id: 1, subject: 'A' }, { id: 'b' }],
          literalRuleIds: [7, 'x', 5],
        },
        meta: { heldAtPublish: true },
      })
    ).toEqual({
      matched: [{ ruleId: 1, reason: ' r ' }],
      snapshot: [{ id: 1, subject: 'A' }],
      literalRuleIds: [7, 5],
      heldAtPublish: true,
    });
  });

  it('degrades to empty for anything else', () => {
    const empty = { matched: [], snapshot: [], literalRuleIds: [], heldAtPublish: false };
    expect(parseModelRulesStoredResult(null)).toEqual(empty);
    expect(parseModelRulesStoredResult({ labels: { modelRules: { matched: 'x' } } })).toEqual(
      empty
    );
    expect(parseModelRulesStoredResult({ modelRules: { literalRuleIds: [3] } })).toEqual({
      ...empty,
      literalRuleIds: [3],
    });
  });
});
