import { describe, expect, it } from 'vitest';
import { findLiteralModelRuleHits } from '~/server/services/text-scan/model-rules-literal';

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
    expect(findLiteralModelRuleHits('Jáne Dœ', [rule(1, 'Jane Do')])).toEqual([]);
    expect(findLiteralModelRuleHits('Jané Doe', [rule(1, 'Jane Doe')])).toEqual([1]);
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
