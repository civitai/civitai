import { describe, expect, it } from 'vitest';
import {
  ALIAS_KINDS,
  MODEL_RULE_LIMITS,
  aliasKindField,
  isSemanticDefinition,
  parseModelRulesHoldMeta,
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

describe('parseModelRulesHoldMeta', () => {
  it('reads a full hold meta back', () => {
    const meta = {
      mode: 'active',
      fields: [{ heading: 'Name', text: 'Hero One LoRA' }],
      matches: [{ ruleId: 3, term: 'Hero One', field: 'Name', fieldIndex: 0, start: 0, end: 8 }],
      rules: [{ id: 3, subject: 'Example Franchise', description: 'd', aliases: ['Hero One'] }],
      applied: true,
      kind: 'redetected',
      priorHoldId: 9,
    };
    expect(parseModelRulesHoldMeta(meta)).toEqual(meta);
  });

  it('keeps the entries that parse and tolerates an empty or missing meta', () => {
    expect(
      parseModelRulesHoldMeta({
        fields: [{ heading: 'Name', text: 'x' }, { heading: 4 }],
        matches: 'nope',
        rules: [{ id: 1, subject: 'S' }],
      })
    ).toEqual({
      mode: 'shadow',
      fields: [{ heading: 'Name', text: 'x' }],
      matches: [],
      rules: [{ id: 1, subject: 'S', description: '', aliases: [] }],
    });
    for (const meta of [null, undefined, 'x', []])
      expect(parseModelRulesHoldMeta(meta)).toMatchObject({ fields: [], matches: [], rules: [] });
  });
});

describe('aliasKindField', () => {
  it('accepts every known kind', () => {
    for (const kind of ALIAS_KINDS) expect(aliasKindField.parse(kind)).toBe(kind);
  });

  it.each(['nickname', '', 5, null, undefined])('files %j under other', (value) => {
    expect(aliasKindField.parse(value)).toBe('other');
  });
});
