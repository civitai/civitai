import { describe, expect, it } from 'vitest';
import {
  convertLegacyModelRule,
  modelRuleFormSchema,
  parseAliases,
  parseRuleMatches,
  ruleMatchesText,
} from '$lib/model-rules';

const content = (match: string) => ({ type: 'content', match });

describe('convertLegacyModelRule', () => {
  it('turns a separator class into a space and drops the word guards', () => {
    const definition = content(String.raw`/(?:\b|\s)Jane[\s\-_]*Doe(?:\b|\s)/gmi`);
    expect(convertLegacyModelRule(definition, 'Requested removal')).toEqual({
      type: 'semantic',
      subject: 'Jane Doe',
      description: 'Requested removal',
      aliases: [],
      legacyMatch: definition,
    });
  });

  it('converts a single token and defaults the description', () => {
    const out = convertLegacyModelRule(
      content(String.raw`/(?:\b|\s)SomeHandle123(?:\b|\s)/gmi`),
      '  '
    );
    expect(out).toMatchObject({
      subject: 'SomeHandle123',
      aliases: [],
      description: 'Takedown request',
    });
    expect(out.needsAttention).toBeUndefined();
  });

  it('keeps a CJK literal', () => {
    expect(convertLegacyModelRule(content('/(?:山田花子)/gmu'), null)).toMatchObject({
      subject: '山田花子',
      aliases: [],
    });
  });

  it('splits an alternation into subject and aliases', () => {
    const out = convertLegacyModelRule(
      content(String.raw`/(?:\b|\s)(?:foo|foo[\s\-_]*bar)(?:\b|\s)/gmi`),
      null
    );
    expect(out).toMatchObject({ subject: 'foo', aliases: ['foo bar'] });
  });

  it('expands a group inside a sequence', () => {
    const out = convertLegacyModelRule(content('/(?:Ann|Anne) Lee/i'), null);
    expect(out).toMatchObject({ subject: 'Ann Lee', aliases: ['Anne Lee'] });
  });

  it('collects nested content rules and dedupes aliases case-insensitively', () => {
    const definition = {
      type: 'or',
      rules: [
        content(String.raw`/(?:\b|\s)Jane[\s\-_]*Doe(?:\b|\s)/gmi`),
        { type: 'or', rules: [content('/JD Handle/i'), content('/jane doe/i')] },
        content('/(?:\\b|\\s)JD Handle(?:\\b|\\s)/'),
      ],
    };
    const out = convertLegacyModelRule(definition, 'Why');
    expect(out.subject).toBe('Jane Doe');
    expect(out.aliases).toEqual(['JD Handle']);
    expect(out.needsAttention).toBeUndefined();
    expect(out.legacyMatch).toBe(definition);
  });

  it('shortens a likeness-claim reason for the scan; the full reason stays the note', () => {
    const out = convertLegacyModelRule(
      content('Jane Doe'),
      'Jane Doe has claimed their digital likeness on Civitai, posting content of them is not allowed'
    );
    expect(out.description).toBe('Real person who has claimed their likeness');
  });

  it('flags a rule whose meaning a subject and aliases cannot carry', () => {
    const andRule = {
      type: 'and',
      rules: [
        { type: 'content', match: '/(?:\\b|\\s)Foo(?:\\b|\\s)/gmi', target: ['name'] },
        { type: 'property', condition: "$.modelVersion.baseModel === 'X'" },
      ],
    };
    expect(convertLegacyModelRule(andRule, null)).toMatchObject({
      subject: 'Foo',
      needsAttention: true,
    });
    const tagRule = { type: 'or', rules: [{ type: 'tag', tags: ['x'], match: 'any' }] };
    expect(convertLegacyModelRule(tagRule, null).needsAttention).toBe(true);
  });

  it('reads escaped punctuation as literal text', () => {
    const out = convertLegacyModelRule(
      content(String.raw`/(?:\b|\s)Jane[\s\-_]*Q\.[\s\-_]*Doe(?:\b|\s)/gmi`),
      null
    );
    expect(out).toMatchObject({ subject: 'Jane Q. Doe', aliases: [] });
    expect(out.needsAttention).toBeUndefined();
  });

  it('accepts a bare string match', () => {
    expect(convertLegacyModelRule(content('Plain Name'), null).subject).toBe('Plain Name');
  });

  it('flags a pattern it cannot reduce and keeps the raw body as the subject', () => {
    const out = convertLegacyModelRule(content(String.raw`/^(?:\b|\s)na+me\d{2,}$/gmi`), null);
    expect(out.subject).toBe(String.raw`^(?:\b|\s)na+me\d{2,}$`);
    expect(out.needsAttention).toBe(true);
    expect(out.aliases).toEqual([]);
  });

  it('flags a rule whose later pattern is unparseable but keeps the good subject', () => {
    const out = convertLegacyModelRule(
      { type: 'or', rules: [content('/Good Name/'), content('/bad[a-z]+/')] },
      null
    );
    expect(out).toMatchObject({ subject: 'Good Name', aliases: [], needsAttention: true });
  });

  it('flags a definition with no content rule', () => {
    expect(convertLegacyModelRule({ type: 'or', rules: [] }, null).needsAttention).toBe(true);
  });

  it('is idempotent on a semantic definition', () => {
    const once = convertLegacyModelRule(content('/Jane Doe/'), 'r');
    expect(convertLegacyModelRule(once, 'other')).toBe(once);
  });
});

describe('parseAliases', () => {
  it('splits on commas and newlines, trims and dedupes case-insensitively', () => {
    expect(parseAliases('Foo  \n foo\n\nBAZ  qux \nDoe, Jane')).toEqual([
      'Foo',
      'BAZ qux',
      'Doe, Jane',
    ]);
  });
});

describe('modelRuleFormSchema', () => {
  it('requires a subject and parses aliases', () => {
    expect(modelRuleFormSchema.safeParse({ subject: '  ' }).success).toBe(false);
    expect(modelRuleFormSchema.parse({ subject: ' A ', aliases: 'b\nc' })).toEqual({
      subject: 'A',
      description: '',
      aliases: ['b', 'c'],
      note: '',
    });
  });
});

describe('ruleMatchesText', () => {
  const rule = { subject: 'Jane Doe', description: 'Requested', aliases: ['JD'] };
  it('matches subject, alias and description case-insensitively', () => {
    expect(ruleMatchesText(rule, 'jane')).toBe(true);
    expect(ruleMatchesText(rule, 'jd')).toBe(true);
    expect(ruleMatchesText(rule, 'REQUEST')).toBe(true);
    expect(ruleMatchesText(rule, 'nobody')).toBe(false);
    expect(ruleMatchesText(rule, '  ')).toBe(true);
  });
});

describe('parseRuleMatches', () => {
  it('joins matched rules to snapshot subjects', () => {
    const result = {
      labels: { modelRules: { matched: [{ ruleId: 5, reason: ' because ' }, { ruleId: 9 }] } },
      modelRules: { snapshot: [{ id: 5, subject: 'Subject Five' }] },
    };
    expect(parseRuleMatches(result)).toEqual([
      { ruleId: 5, subject: 'Subject Five', reason: 'because' },
      { ruleId: 9, subject: null, reason: null },
    ]);
  });

  it('tolerates a missing or malformed result', () => {
    expect(parseRuleMatches(null)).toEqual([]);
    expect(parseRuleMatches({ labels: {} })).toEqual([]);
    expect(parseRuleMatches({ labels: { modelRules: { matched: 'x' } } })).toEqual([]);
  });
});
