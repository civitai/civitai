import { describe, expect, it } from 'vitest';
import { diffLines, type DiffLine } from '../text-scan-lab/diff';

const render = (lines: DiffLine[]) =>
  lines.map((l) => `${l.op === 'same' ? ' ' : l.op === 'add' ? '+' : '-'}${l.text}`);

/** Replaying a diff must give back both inputs exactly — the property every caller relies on. */
const replay = (lines: DiffLine[]) => ({
  before: lines
    .filter((l) => l.op !== 'add')
    .map((l) => l.text)
    .join('\n'),
  after: lines
    .filter((l) => l.op !== 'del')
    .map((l) => l.text)
    .join('\n'),
});

describe('diffLines', () => {
  it('marks identical text as unchanged', () => {
    expect(render(diffLines('a\nb', 'a\nb'))).toEqual([' a', ' b']);
  });

  it('shows a changed middle line as one deletion and one addition', () => {
    expect(render(diffLines('a\nb\nc', 'a\nB\nc'))).toEqual([' a', '-b', '+B', ' c']);
  });

  it('keeps the longest common subsequence rather than the common prefix', () => {
    expect(render(diffLines('x\na\nb\nc', 'a\nb\nc\ny'))).toEqual(['-x', ' a', ' b', ' c', '+y']);
  });

  it('handles an empty side', () => {
    expect(render(diffLines('', 'a'))).toEqual(['-', '+a']);
    expect(render(diffLines('a\nb', 'a'))).toEqual([' a', '-b']);
  });

  it('round-trips both inputs', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\nsix';
    const after = 'zero\none\nthree\nFOUR\nfive\nsix\nseven';
    expect(replay(diffLines(before, after))).toEqual({ before, after });
  });

  it('reports the minimum number of changed lines', () => {
    const changed = diffLines('a\nb\nc\nd\ne', 'a\nc\nd\nX\ne').filter((l) => l.op !== 'same');
    expect(changed).toEqual([
      { op: 'del', text: 'b' },
      { op: 'add', text: 'X' },
    ]);
  });
});
