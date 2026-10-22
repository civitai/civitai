import { describe, expect, it } from 'vitest';
import {
  ALIAS_SUGGEST_SYSTEM_PROMPT,
  buildAliasSuggestionMessages,
  filterAliasSuggestions,
  parseAliasSuggestions,
} from '~/server/services/text-scan/model-rule-aliases';

const suggestion = (alias: string, extra: Record<string, unknown> = {}) => ({
  alias,
  kind: 'other',
  note: null,
  source: null,
  ...extra,
});

describe('filterAliasSuggestions', () => {
  const base = { subject: 'Alpha Beta', existingAliases: ['Gamma Delta'] };

  it('drops the subject and existing aliases under the matcher normalization', () => {
    const out = filterAliasSuggestions(
      [suggestion('alpha_beta'), suggestion('GAMMA-delta'), suggestion('Epsilon Zeta')],
      base
    );
    expect(out.map((s) => s.alias)).toEqual(['Epsilon Zeta']);
  });

  it('keeps the first of suggestions that normalize alike', () => {
    const out = filterAliasSuggestions([suggestion('Foo_Bar'), suggestion('foo bar')], base);
    expect(out.map((s) => s.alias)).toEqual(['Foo_Bar']);
  });

  it('drops terms the matcher would ignore: too short and over the word cap', () => {
    const out = filterAliasSuggestions(
      [
        suggestion('ab'),
        suggestion('a.'),
        suggestion('one two three four five six seven eight nine'),
      ],
      base
    );
    expect(out).toEqual([]);
  });

  it('trims aliases and drops ones over the alias length', () => {
    const out = filterAliasSuggestions(
      [suggestion('  Padded Name  '), suggestion('x'.repeat(201))],
      base
    );
    expect(out.map((s) => s.alias)).toEqual(['Padded Name']);
  });

  it('keeps only http(s) sources and omits empty notes', () => {
    const out = filterAliasSuggestions(
      [
        suggestion('One Name', { source: 'https://example.com/a', note: 'seen here' }),
        suggestion('Two Name', { source: 'javascript:alert(1)', note: '  ' }),
      ],
      base
    );
    expect(out).toEqual([
      { alias: 'One Name', kind: 'other', note: 'seen here', source: 'https://example.com/a' },
      { alias: 'Two Name', kind: 'other' },
    ]);
  });
});

describe('parseAliasSuggestions', () => {
  const step = (content: unknown, finishReason = 'stop', parsed?: unknown) => ({
    output: { choices: [{ message: { content }, finishReason }], parsed },
  });
  const good = { suggestions: [suggestion('Some Name', { kind: 'stage_name' })] };

  it('reads the JSON reply', () => {
    expect(parseAliasSuggestions(step(JSON.stringify(good)))).toEqual({
      ok: true,
      suggestions: good.suggestions,
    });
  });

  it('prefers the parsed output', () => {
    expect(parseAliasSuggestions(step('', 'stop', good))).toMatchObject({ ok: true });
  });

  it.each([
    ['empty reply', step('')],
    ['not JSON', step('Here are some names')],
    ['wrong shape', step(JSON.stringify({ names: ['x'] }))],
    [
      'unknown kind',
      step(JSON.stringify({ suggestions: [suggestion('Name Here', { kind: 'nickname' })] })),
    ],
    ['non-string alias', step(JSON.stringify({ suggestions: [suggestion(5 as never)] }))],
    ['cut off', step(JSON.stringify(good), 'length')],
    ['filtered', step('', 'content_filter')],
  ])('rejects %s', (_, input) => {
    const result = parseAliasSuggestions(input);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('error');
  });
});

describe('prompt', () => {
  it('passes the rule as data and names no one', () => {
    const messages = buildAliasSuggestionMessages({
      subject: 'Alpha Beta',
      description: 'A description',
      existingAliases: ['Gamma Delta'],
    });
    expect(messages[0]).toEqual({ role: 'system', content: ALIAS_SUGGEST_SYSTEM_PROMPT });
    expect(JSON.parse(messages[1].content)).toEqual({
      subject: 'Alpha Beta',
      description: 'A description',
      existingAliases: ['Gamma Delta'],
    });
  });
});
