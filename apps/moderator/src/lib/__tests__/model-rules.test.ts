import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  modelRuleFormSchema,
  parseAliases,
  parseMatchCursor,
  parseRuleMatches,
  ruleMatchesText,
} from '$lib/model-rules';

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
      { ruleId: 5, subject: 'Subject Five', reason: 'because', llm: true, literal: false },
      { ruleId: 9, subject: null, reason: null, llm: true, literal: false },
    ]);
  });

  it('flags the rules the text names literally, and lists a literal-only hit the model missed', () => {
    const result = {
      labels: { modelRules: { matched: [{ ruleId: 5, reason: 'because' }] } },
      modelRules: {
        snapshot: [
          { id: 5, subject: 'Subject Five' },
          { id: 7, subject: 'Subject Seven' },
        ],
        literalRuleIds: [7, 5, 7, 'x'],
      },
    };
    expect(parseRuleMatches(result)).toEqual([
      { ruleId: 5, subject: 'Subject Five', reason: 'because', llm: true, literal: true },
      { ruleId: 7, subject: 'Subject Seven', reason: null, llm: false, literal: true },
    ]);
  });

  it('reads a literal-only result with no model verdict at all', () => {
    expect(parseRuleMatches({ modelRules: { snapshot: [], literalRuleIds: [3] } })).toEqual([
      { ruleId: 3, subject: null, reason: null, llm: false, literal: true },
    ]);
  });

  it('keeps the first match per rule so the matches tab can key rows by rule id', () => {
    const result = {
      labels: {
        modelRules: {
          matched: [
            { ruleId: 5, reason: 'first' },
            { ruleId: 9, reason: 'other' },
            { ruleId: 5, reason: 'second' },
          ],
        },
      },
    };
    expect(parseRuleMatches(result)).toEqual([
      { ruleId: 5, subject: null, reason: 'first', llm: true, literal: false },
      { ruleId: 9, subject: null, reason: 'other', llm: true, literal: false },
    ]);
  });

  it('tolerates a missing or malformed result', () => {
    expect(parseRuleMatches(null)).toEqual([]);
    expect(parseRuleMatches({ labels: {} })).toEqual([]);
    expect(parseRuleMatches({ labels: { modelRules: { matched: 'x' } } })).toEqual([]);
  });
});

describe('parseMatchCursor', () => {
  it('parses a timestamp with and without fractional seconds', () => {
    expect(parseMatchCursor('2026-05-02 10:11:12|42')).toEqual({
      updatedAt: '2026-05-02 10:11:12',
      id: 42,
    });
    expect(parseMatchCursor('2026-05-02 10:11:12.123456|7')).toEqual({
      updatedAt: '2026-05-02 10:11:12.123456',
      id: 7,
    });
  });

  it('rejects anything else', () => {
    expect(parseMatchCursor('garbage')).toBeUndefined();
    expect(parseMatchCursor('2026-05-02T10:11:12Z|42')).toBeUndefined();
    expect(parseMatchCursor(undefined)).toBeUndefined();
  });
});

describe('Matches list and its partial index', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const service = read('../server/model-rules.service.ts');
  const migration = read(
    '../../../../../packages/civitai-db-schema/prisma/migrations/20261015120000_entity_moderation_model_rules_matches_idx/migration.sql'
  );

  // The planner only uses the partial index when the query repeats its predicate.
  it('finds literal-only hits, and repeats the index predicate in the query', () => {
    for (const label of ['modelRules', 'modelRulesLiteral']) {
      expect(migration).toContain(`'${label}' = ANY("triggeredLabels")`);
      expect(service).toContain(`'${label}' = ANY(em."triggeredLabels")`);
    }
  });

  it('filters by rule id on literal hits as well as model matches', () => {
    expect(service).toContain("{modelRules,literalRuleIds}'");
  });
});
