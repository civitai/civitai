import { describe, expect, it, vi } from 'vitest';
import type * as ConfusableFold from '~/server/utils/confusable-fold';

const { foldSpy } = vi.hoisted(() => ({ foldSpy: vi.fn() }));
vi.mock('~/server/utils/confusable-fold', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfusableFold>();
  return {
    ...actual,
    foldConfusables: (value: string) => {
      foldSpy(value);
      return actual.foldConfusables(value);
    },
  };
});

import { findLiteralMatchesInSubject } from '~/server/services/text-scan/model-rules-literal';

const rule = (id: number, subject: string, aliases: string[] = []) => ({ id, subject, aliases });

const hitsIn = (
  fields: (string | null)[],
  rules: ReturnType<typeof rule>[]
): number[] => {
  const matched = new Set(
    findLiteralMatchesInSubject(
      { fields: fields.map((text, i) => ({ heading: `f${i}`, text })), declared: {} },
      rules
    ).map((m) => m.ruleId)
  );
  return rules.filter((r) => matched.has(r.id)).map((r) => r.id);
};
const findLiteralModelRuleHits = (text: string, rules: ReturnType<typeof rule>[]) =>
  hitsIn([text], rules);

describe('findLiteralModelRuleHits', () => {
  it('matches case-insensitively on whole words', () => {
    expect(findLiteralModelRuleHits('A LoRA of Jane Doe in a park', [rule(1, 'jane doe')])).toEqual(
      [1]
    );
  });

  it('matches an alias', () => {
    expect(
      findLiteralModelRuleHits('the Hero One style', [rule(1, 'Example Franchise', ['Hero One'])])
    ).toEqual([1]);
  });

  it('folds diacritics on both sides', () => {
    expect(findLiteralModelRuleHits('Jané Doe', [rule(1, 'Jane Doe')])).toEqual([1]);
    expect(findLiteralModelRuleHits('Jané Doering', [rule(1, 'Jane Doe')])).toEqual([]);
    expect(findLiteralModelRuleHits('Jane Doe', [rule(1, 'Jané Doe')])).toEqual([1]);
  });

  it('folds confusables and invisible characters', () => {
    expect(findLiteralModelRuleHits('Jаne​ Doe', [rule(1, 'Jane Doe')])).toEqual([1]);
    expect(findLiteralModelRuleHits('ＪＡＮＥ ＤＯＥ', [rule(1, 'Jane Doe')])).toEqual([1]);
  });

  it('treats separators and punctuation as one space', () => {
    expect(findLiteralModelRuleHits('foo-bar, foo_bar, foo.bar', [rule(1, 'foo bar')])).toEqual([
      1,
    ]);
    expect(findLiteralModelRuleHits('foo bar', [rule(1, 'foo-bar')])).toEqual([1]);
    expect(findLiteralModelRuleHits('foo   \n bar', [rule(1, 'foo bar')])).toEqual([1]);
  });

  it('does not match inside a longer word', () => {
    expect(findLiteralModelRuleHits('a party hat', [rule(1, 'art')])).toEqual([]);
    expect(findLiteralModelRuleHits('smart art', [rule(1, 'art')])).toEqual([1]);
    expect(findLiteralModelRuleHits('foo barn', [rule(1, 'foo bar')])).toEqual([]);
  });

  it('ignores terms shorter than 3 characters after folding', () => {
    expect(findLiteralModelRuleHits('go to ab now', [rule(1, 'ab', ['--', 'x'])])).toEqual([]);
  });

  it('returns each matching rule once, in rule order', () => {
    const rules = [rule(2, 'alpha', ['alpha beta']), rule(1, 'beta')];
    expect(findLiteralModelRuleHits('alpha beta alpha', rules)).toEqual([2, 1]);
  });

  it('returns nothing for empty text or no rules', () => {
    expect(findLiteralModelRuleHits('', [rule(1, 'alpha')])).toEqual([]);
    expect(findLiteralModelRuleHits('alpha', [])).toEqual([]);
  });
});

describe('rule normalization memo', () => {
  it('normalizes a rule set once, and again when a rule changes', () => {
    const rules = [rule(1, 'memo subject', ['memo alias'])];
    const termFolds = () =>
      foldSpy.mock.calls.map(([v]) => v).filter((v) => /^(memo subject|memo alias|new alias)$/.test(v));
    findLiteralModelRuleHits('x', rules);
    foldSpy.mockClear();

    findLiteralModelRuleHits('a memo alias here', [rule(1, 'memo subject', ['memo alias'])]);
    expect(termFolds()).toEqual([]);

    foldSpy.mockClear();
    expect(
      findLiteralModelRuleHits('a new alias here', [rule(1, 'memo subject', ['new alias'])])
    ).toEqual([1]);
    expect(termFolds()).toEqual(['memo subject', 'new alias']);
  });

  it('matches phrases longer than the other terms', () => {
    const rules = [rule(1, 'one two three four', ['abc']), rule(2, 'two three')];
    expect(findLiteralModelRuleHits('x one two three four y', rules)).toEqual([1, 2]);
    expect(findLiteralModelRuleHits('x one two three y', rules)).toEqual([2]);
  });
});

describe('matching across fields', () => {
  it('does not match a phrase split across two fields', () => {
    expect(hitsIn(['about jane', 'doe portrait'], [rule(1, 'jane doe')])).toEqual([]);
  });

  it('matches a phrase inside one field', () => {
    expect(hitsIn(['a style', 'about jane doe'], [rule(1, 'jane doe')])).toEqual([1]);
  });

  it('unions hits across fields in rule order', () => {
    const rules = [rule(2, 'alpha'), rule(1, 'beta')];
    expect(hitsIn(['beta', null, 'alpha'], rules)).toEqual([2, 1]);
  });
});

describe('term word cap', () => {
  const long = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(' ');

  it('ignores a stored term longer than the cap and still matches the rest', () => {
    const rules = [rule(1, 'Jane Doe', [long]), rule(2, long)];
    expect(findLiteralModelRuleHits(`${long} met Jane Doe`, rules)).toEqual([1]);
  });
});

describe('findLiteralMatchesInSubject', () => {
  const subject = (...fields: [string, string | null][]) =>
    ({ fields: fields.map(([heading, text]) => ({ heading, text })), declared: {} } as never);
  const spans = (matches: { fieldIndex: number; start: number; end: number }[], texts: string[]) =>
    matches.map((m) => texts[m.fieldIndex].slice(m.start, m.end));

  it('points at the span as written, across underscores and punctuation', () => {
    const text = 'by Zed -- Quux_Plinth_v2 (final)';
    const matches = findLiteralMatchesInSubject(subject(['Name', text]), [
      rule(7, 'Example Franchise', ['quux plinth']),
    ]);
    expect(matches).toEqual([
      { ruleId: 7, term: 'quux plinth', field: 'Name', fieldIndex: 0, start: 10, end: 21 },
    ]);
    expect(spans(matches, [text])).toEqual(['Quux_Plinth']);
  });

  it('maps offsets back through diacritics, confusables and invisible characters', () => {
    const text = 'x Jané Dоe\u200B portrait Jane\u0301 Doe';
    const matches = findLiteralMatchesInSubject(subject(['Description', text]), [
      rule(1, 'Jane Doe'),
    ]);
    expect(spans(matches, [text])).toEqual(['Jané Dоe', 'Jane\u0301 Doe']);
  });

  it('reports every occurrence, each field, and the authored term', () => {
    const texts = ['alpha beta alpha', 'nothing', 'ALPHA!'];
    const matches = findLiteralMatchesInSubject(
      subject(['Name', texts[0]], ['Version name', texts[1]], ['Trained words', texts[2]]),
      [rule(3, 'Alpha'), rule(4, 'beta thing', ['Beta'])]
    );
    expect(matches.map((m) => [m.ruleId, m.term, m.field])).toEqual([
      [3, 'Alpha', 'Name'],
      [4, 'Beta', 'Name'],
      [3, 'Alpha', 'Name'],
      [3, 'Alpha', 'Trained words'],
    ]);
    expect(spans(matches, texts)).toEqual(['alpha', 'beta', 'alpha', 'ALPHA']);
  });

  it('returns nothing when nothing matches', () => {
    const rules = [rule(1, 'alpha'), rule(2, 'gamma delta')];
    const s = subject(['Name', 'alphabet soup'], ['Description', 'gamma then delta']);
    expect(findLiteralMatchesInSubject(s, rules)).toEqual([]);
    expect(findLiteralMatchesInSubject(subject(['Name', 'Alpha']), [])).toEqual([]);
  });
});
