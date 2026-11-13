import { describe, expect, it } from 'vitest';
import { promptDiff } from '../prompt-diff';

const text = (parts: { kind: string; text: string }[], kind: string) =>
  parts
    .filter((p) => p.kind === kind)
    .map((p) => p.text.trim())
    .join('|');

describe('promptDiff', () => {
  it('marks identical prompts as all same', () => {
    expect(promptDiff('a cat sits', 'a cat sits').every((p) => p.kind === 'same')).toBe(true);
  });

  it('finds an added word', () => {
    const parts = promptDiff('a cat sits', 'a big cat sits');
    expect(text(parts, 'added')).toBe('big');
    expect(text(parts, 'removed')).toBe('');
  });

  it('finds a removed word', () => {
    const parts = promptDiff('a big cat sits', 'a cat sits');
    expect(text(parts, 'removed')).toBe('big');
    expect(text(parts, 'added')).toBe('');
  });

  it('finds a substitution', () => {
    const parts = promptDiff('a cat sits', 'a dog sits');
    expect(text(parts, 'removed')).toBe('cat');
    expect(text(parts, 'added')).toBe('dog');
  });

  it('reproduces the submitted prompt from same and added parts', () => {
    const submitted = 'masterpiece, a  dog\nruns fast';
    const parts = promptDiff('a cat runs', submitted);
    expect(
      parts
        .filter((p) => p.kind !== 'removed')
        .map((p) => p.text)
        .join('')
    ).toBe(submitted);
  });

  it('handles empty sides', () => {
    expect(promptDiff('', 'new words')).toEqual([{ kind: 'added', text: 'new words' }]);
    expect(promptDiff('old words', '')).toEqual([{ kind: 'removed', text: 'old words' }]);
    expect(promptDiff('', '')).toEqual([]);
  });

  it('stays bounded on very long, unrelated prompts', () => {
    const a = Array.from({ length: 6000 }, (_, i) => `a${i}`).join(' ');
    const b = Array.from({ length: 6000 }, (_, i) => `b${i}`).join(' ');
    const parts = promptDiff(a, b);
    expect(text(parts, 'removed')).toContain('a0');
    expect(text(parts, 'added')).toContain('b5999');
  });
});
