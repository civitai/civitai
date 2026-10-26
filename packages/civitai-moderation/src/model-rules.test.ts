import { describe, expect, it } from 'vitest';
import {
  ALIAS_KINDS,
  MODEL_RULE_LIMITS,
  aliasKindField,
  aliasWorkflowIdField,
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
      references: [],
    });
  });

  it('accepts a category and trimmed http(s) references, dropping an empty label', () => {
    expect(
      semanticModelRuleSchema.parse({
        type: 'semantic',
        subject: 'Jane',
        category: 'artist',
        references: [
          { url: ' https://example.com/a ', label: ' Portfolio ' },
          { url: 'http://example.com/b', label: '  ' },
        ],
      })
    ).toMatchObject({
      category: 'artist',
      references: [
        { url: 'https://example.com/a', label: 'Portfolio' },
        { url: 'http://example.com/b', label: undefined },
      ],
    });
  });

  it.each([
    ['an unknown category', { category: 'celebrity' }],
    ['a non-http link', { references: [{ url: 'javascript:alert(1)' }] }],
    ['a link that is not a URL', { references: [{ url: 'example' }] }],
    ['a link over the cap', { references: [{ url: `https://example.com/${'a'.repeat(500)}` }] }],
    ['a label over the cap', { references: [{ url: 'https://example.com', label: 'a'.repeat(101) }] }],
    [
      'too many references',
      {
        references: Array.from({ length: MODEL_RULE_LIMITS.referencesPerRule + 1 }, (_, i) => ({
          url: `https://example.com/${i}`,
        })),
      },
    ],
  ])('rejects %s', (_name, extra) => {
    expect(
      semanticModelRuleSchema.safeParse({ type: 'semantic', subject: 'Jane', ...extra }).success
    ).toBe(false);
  });

  it('lets the matcher read a stored rule whose new fields are malformed', () => {
    const parsed = storedModelRuleSchema.parse({
      type: 'semantic',
      subject: 'Jane',
      category: 'celebrity',
      references: [{ url: 'https://example.com/ok' }, { url: 'ftp://example.com' }, 'nope'],
    });
    expect(parsed.category).toBeUndefined();
    expect(parsed.references).toEqual([{ url: 'https://example.com/ok', label: undefined }]);
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
      rules: [
        {
          id: 3,
          subject: 'Example Franchise',
          description: 'd',
          aliases: ['Hero One'],
          category: 'ip',
          references: [{ url: 'https://example.com/ref', label: 'Official art' }],
        },
      ],
      applied: true,
      kind: 'redetected',
      priorHoldId: 9,
    };
    expect(parseModelRulesHoldMeta(meta)).toEqual(meta);
  });

  it('keeps the category and references of a snapshot, and tolerates a snapshot without them', () => {
    const parsed = parseModelRulesHoldMeta({
      rules: [
        {
          id: 1,
          subject: 'A',
          category: 'ip',
          references: [{ url: 'https://example.com/x', label: 'X' }, { url: 'bad' }],
        },
        { id: 2, subject: 'B', category: 'nope', references: 'nope' },
        { id: 3, subject: 'C' },
      ],
    });
    expect(parsed.rules).toMatchObject([
      { id: 1, category: 'ip', references: [{ url: 'https://example.com/x', label: 'X' }] },
      { id: 2, references: [] },
      { id: 3, references: [] },
    ]);
    expect(parsed.rules[1].category).toBeUndefined();
    expect(parsed.rules[2].category).toBeUndefined();
  });

  it('keeps the source of a hold a training run recorded, and drops one it does not know', () => {
    expect(parseModelRulesHoldMeta({ source: 'training' })).toMatchObject({ source: 'training' });
    expect(parseModelRulesHoldMeta({ source: 'elsewhere' })).not.toHaveProperty('source');
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
      rules: [{ id: 1, subject: 'S', description: '', aliases: [], references: [] }],
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

describe('aliasWorkflowIdField', () => {
  it('accepts an opaque token', () => {
    expect(aliasWorkflowIdField.parse('wf_0123456789-AB')).toBe('wf_0123456789-AB');
  });

  it.each(['', 'short', '../etc/passwd', 'has space 1234', 'a'.repeat(129), 5, null])(
    'rejects %j',
    (value) => {
      expect(aliasWorkflowIdField.safeParse(value).success).toBe(false);
    }
  );
});
