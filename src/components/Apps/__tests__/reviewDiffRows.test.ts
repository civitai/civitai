import { describe, expect, test } from 'vitest';
import {
  diffLineKind,
  hunkRangeLabel,
  splitDiffRows,
  unifiedDiffRows,
  type DiffHunk,
} from '~/components/Apps/reviewDiffRows';

/**
 * The GitHub-shaped diff viewer's LINE-NUMBER MAPPING, in the node-env `unit` project.
 *
 * 🔴 THIS IS THE PART THAT CAN BE SILENTLY WRONG. A renderer that paints the right colours
 * against the wrong numbers looks completely fine — a moderator reading "line 42" would be
 * reading line 43 — and the browser tier that renders it is report-only in CI. So the walk
 * is pinned here, against hunks shaped exactly like the ones `computeBundleLineDiff` emits
 * (jsdiff `structuredPatch`, `' '`/`'+'`/`'-'` prefixes, `context: 3`).
 */

/** A hunk from the middle of a file, so a wrong `oldStart`/`newStart` cannot hide at 1. */
const EDIT: DiffHunk = {
  oldStart: 41,
  oldLines: 3,
  newStart: 41,
  newLines: 4,
  lines: [
    ' const x = useState()',
    '+const y = useMemo(() => 1, [])',
    '-const y = compute()',
    ' return <div/>',
  ],
};

describe('hunkRangeLabel', () => {
  test('is the unified `@@` header', () => {
    expect(hunkRangeLabel(EDIT)).toBe('@@ -41,3 +41,4 @@');
  });
});

describe('diffLineKind', () => {
  test('classifies by sigil, and treats an EMPTY line as context', () => {
    expect(diffLineKind(' ok')).toBe('context');
    expect(diffLineKind('+added')).toBe('add');
    expect(diffLineKind('-removed')).toBe('del');
    expect(diffLineKind('\\ No newline at end of file')).toBe('meta');
    // An empty string is a context line with no content, not an unknown kind — jsdiff emits
    // one for a blank unchanged line.
    expect(diffLineKind('')).toBe('context');
  });
});

describe('unifiedDiffRows', () => {
  test('🔴 the numbers: context advances BOTH sides, an add only the new, a delete only the old', () => {
    const rows = unifiedDiffRows([EDIT]);
    // Row 0 is the hunk header.
    expect(rows[0]).toMatchObject({ kind: 'hunk', label: '@@ -41,3 +41,4 @@' });
    // The four code rows, as a single table so a failure names every offending row.
    expect(rows.slice(1).map((r) => (r.kind === 'hunk' ? r : [r.kind, r.oldNo, r.newNo]))).toEqual([
      ['context', 41, 41],
      ['add', null, 42],
      ['del', 42, null],
      ['context', 43, 43],
    ]);
  });

  test('the rendered text keeps its sigil; `text` is the stripped content', () => {
    const rows = unifiedDiffRows([EDIT]);
    const add = rows.find((r) => r.kind === 'add');
    expect(add).toBeDefined();
    if (add && add.kind !== 'hunk') {
      expect(add.raw).toBe('+const y = useMemo(() => 1, [])');
      expect(add.text).toBe('const y = useMemo(() => 1, [])');
    }
  });

  test('🔴 a `\\ No newline` MARKER ADVANCES NEITHER COUNTER', () => {
    // Treating it as context — the obvious shortcut — advances both and shifts every number
    // after it by one. jsdiff emits it for a file with no trailing newline, which is common.
    const rows = unifiedDiffRows([
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [' a', '-b', '\\ No newline at end of file', '+b2', ' c'],
      },
    ]);
    expect(rows.slice(1).map((r) => (r.kind === 'hunk' ? r : [r.kind, r.oldNo, r.newNo]))).toEqual([
      ['context', 1, 1],
      ['del', 2, null],
      ['meta', null, null],
      ['add', null, 2],
      ['context', 3, 3],
    ]);
  });

  test('a SECOND hunk restarts from its own starts, not from where the first stopped', () => {
    const rows = unifiedDiffRows([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' a'] },
      { oldStart: 90, oldLines: 1, newStart: 91, newLines: 1, lines: [' z'] },
    ]);
    // `.filter` already narrows the union, so the ternary a sibling case needs here would
    // be a comparison TypeScript knows cannot hold (TS2367).
    const code = rows.filter((r) => r.kind !== 'hunk');
    expect(code.map((r) => [r.oldNo, r.newNo])).toEqual([
      [1, 1],
      [90, 91],
    ]);
    expect(rows.filter((r) => r.kind === 'hunk')).toHaveLength(2);
  });

  test('a whole-file ADD (first version) numbers only the new side', () => {
    const rows = unifiedDiffRows([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+one', '+two'] },
    ]);
    expect(rows.slice(1).map((r) => (r.kind === 'hunk' ? r : [r.kind, r.oldNo, r.newNo]))).toEqual([
      ['add', null, 1],
      ['add', null, 2],
    ]);
  });

  test('no hunks ⇒ no rows (not a header with nothing under it)', () => {
    expect(unifiedDiffRows([])).toEqual([]);
  });

  test('every row key is unique — React would silently drop a duplicate', () => {
    const rows = unifiedDiffRows([EDIT, { ...EDIT, oldStart: 80, newStart: 80 }]);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('splitDiffRows', () => {
  test('🔴 a RUN of deletes pairs with the RUN of adds that follows it, not line-for-line', () => {
    // A unified hunk emits every `-` of an edit before every `+`. Pairing them as they
    // arrive would put each removal opposite a context line, which is the defect that makes
    // a side-by-side view unreadable.
    const rows = splitDiffRows([EDIT]);
    expect(rows[0]).toMatchObject({ kind: 'hunk' });
    const pairs = rows
      .slice(1)
      .map((r) => (r.kind === 'hunk' ? r : [r.left.kind, r.left.no, r.right.kind, r.right.no]));
    expect(pairs).toEqual([
      ['context', 41, 'context', 41],
      // the deleted line sits opposite the added one, as ONE changed row
      ['del', 42, 'add', 42],
      ['context', 43, 'context', 43],
    ]);
  });

  test('🔴 an UNEVEN run gets `empty` filler on the short side', () => {
    // 3 lines replaced by 1: three rows, two of them with a blank right cell.
    const rows = splitDiffRows([
      {
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 1,
        lines: ['-a', '-b', '-c', '+abc'],
      },
    ]);
    expect(rows.slice(1).map((r) => (r.kind === 'hunk' ? r : [r.left.kind, r.right.kind]))).toEqual(
      [
        ['del', 'add'],
        ['del', 'empty'],
        ['del', 'empty'],
      ]
    );
    // …and the numbering is still each side's own.
    const nums = rows.slice(1).map((r) => (r.kind === 'hunk' ? null : [r.left.no, r.right.no]));
    expect(nums).toEqual([
      [10, 10],
      [11, null],
      [12, null],
    ]);
  });

  test('a pure ADD run has empty left cells', () => {
    const rows = splitDiffRows([
      { oldStart: 5, oldLines: 0, newStart: 5, newLines: 2, lines: ['+x', '+y'] },
    ]);
    expect(
      rows.slice(1).map((r) => (r.kind === 'hunk' ? r : [r.left.kind, r.right.kind, r.right.no]))
    ).toEqual([
      ['empty', 'add', 5],
      ['empty', 'add', 6],
    ]);
  });

  test('🔴 TWO SEPARATE runs in one hunk are flushed separately, not merged', () => {
    // Without a flush at each context boundary the second run's adds would pair with the
    // first run's deletes.
    const rows = splitDiffRows([
      {
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 4,
        lines: ['-a', '+A', ' mid', '-b', '+B'],
      },
    ]);
    expect(
      rows.slice(1).map((r) => (r.kind === 'hunk' ? r : [r.left.kind, r.left.no, r.right.no]))
    ).toEqual([
      ['del', 1, 1],
      ['context', 2, 2],
      ['del', 3, 3],
    ]);
  });

  test('a `meta` marker shows on both sides and numbers neither', () => {
    const rows = splitDiffRows([
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [' a', '\\ No newline at end of file'],
      },
    ]);
    const meta = rows.find((r) => r.kind === 'pair' && r.left.kind === 'meta');
    expect(meta).toBeDefined();
    if (meta && meta.kind === 'pair') {
      expect(meta.left.no).toBeNull();
      expect(meta.right.no).toBeNull();
      expect(meta.left.text).toContain('No newline');
    }
  });

  test('every row key is unique across runs and hunks', () => {
    const rows = splitDiffRows([
      { oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: ['-a', '+A', ' m', '-b', '+B'] },
      { oldStart: 50, oldLines: 1, newStart: 50, newLines: 1, lines: ['-z', '+Z'] },
    ]);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('🔴 BOTH LAYOUTS SEE THE SAME CONTENT — neither drops a line', () => {
    // The two walks are separate code paths over one input, so the cheap cross-check is
    // that they account for every line. A split view that quietly swallowed the tail of a
    // run would still look plausible on its own.
    const hunks = [EDIT];
    const unifiedText = unifiedDiffRows(hunks)
      .filter((r) => r.kind !== 'hunk')
      .map((r) => r.raw)
      .sort();
    const splitText = splitDiffRows(hunks)
      .flatMap((r) =>
        r.kind === 'hunk'
          ? []
          : [r.left, r.right].filter((c) => c.kind !== 'empty').map((c) => c.raw)
      )
      // A context line appears on both sides of a split row — dedupe by counting distinct
      // content, which is what "no line was dropped" actually means here.
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort();
    expect(splitText).toEqual(unifiedText.filter((v, i, a) => a.indexOf(v) === i));
  });
});
