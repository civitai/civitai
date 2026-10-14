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

import {
  findLiteralHitsInSubject,
  findLiteralModelRuleHits,
} from '~/server/services/text-scan/model-rules-literal';

const rule = (id: number, subject: string, aliases: string[] = []) => ({ id, subject, aliases });

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
    findLiteralModelRuleHits('x', rules);
    foldSpy.mockClear();

    findLiteralModelRuleHits('a memo alias here', [rule(1, 'memo subject', ['memo alias'])]);
    expect(foldSpy.mock.calls.map(([v]) => v)).toEqual(['a memo alias here']);

    foldSpy.mockClear();
    expect(
      findLiteralModelRuleHits('a new alias here', [rule(1, 'memo subject', ['new alias'])])
    ).toEqual([1]);
    expect(foldSpy).toHaveBeenCalledTimes(3);
  });

  it('matches phrases longer than the other terms', () => {
    const rules = [rule(1, 'one two three four', ['abc']), rule(2, 'two three')];
    expect(findLiteralModelRuleHits('x one two three four y', rules)).toEqual([1, 2]);
    expect(findLiteralModelRuleHits('x one two three y', rules)).toEqual([2]);
  });
});

describe('findLiteralHitsInSubject', () => {
  const subject = (...texts: (string | null)[]) =>
    ({
      fields: texts.map((text, i) => ({ heading: `f${i}`, text })),
      declared: {},
    } as never);

  it('does not match a phrase split across two fields', () => {
    expect(
      findLiteralHitsInSubject(subject('about jane', 'doe portrait'), [rule(1, 'jane doe')])
    ).toEqual([]);
  });

  it('matches a phrase inside one field', () => {
    expect(
      findLiteralHitsInSubject(subject('a style', 'about jane doe'), [rule(1, 'jane doe')])
    ).toEqual([1]);
  });

  it('unions hits across fields in rule order', () => {
    const rules = [rule(2, 'alpha'), rule(1, 'beta')];
    expect(findLiteralHitsInSubject(subject('beta', null, 'alpha'), rules)).toEqual([2, 1]);
  });
});

describe('term word cap', () => {
  const long = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(' ');

  it('ignores a stored term longer than the cap and still matches the rest', () => {
    const rules = [rule(1, 'Jane Doe', [long]), rule(2, long)];
    expect(findLiteralModelRuleHits(`${long} met Jane Doe`, rules)).toEqual([1]);
  });
});
