import { describe, expect, it } from 'vitest';
import {
  missingUpdatePaths,
  pathHoldsUpdate,
} from '~/server/services/blocks/platform-update-containment';

/**
 * The ONE "does this tree hold the staff update" predicate, shared by the submit and approve
 * checks and App Assistant's merged report. Each case pins one clause of the rule.
 */

const b = (s: string) => Buffer.from(s, 'utf8');
const BASE = 'line one\nline two\n';
const UPDATE = 'line one\nline two\nadded by staff\n';
const NOT_UTF8 = Buffer.from([0xff, 0xfe, 0x00, 0x41]);

describe('pathHoldsUpdate', () => {
  it('holds when the tree has the update’s exact bytes', () => {
    expect(pathHoldsUpdate({ want: b(UPDATE), base: b(BASE), have: b(UPDATE) })).toBe(true);
  });

  it('holds a hand-merged text file that has every line the update adds', () => {
    const merged = 'owner header\nline one\nline two\nadded by staff\nowner footer\n';
    expect(pathHoldsUpdate({ want: b(UPDATE), base: b(BASE), have: b(merged) })).toBe(true);
  });

  it('does not hold a file missing one added line', () => {
    const want = 'line one\nfirst added\nline two\nsecond added\n';
    const have = 'line one\nfirst added\nline two\nowner edit\n';
    expect(pathHoldsUpdate({ want: b(want), base: b(BASE), have: b(have) })).toBe(false);
  });

  it('does not hold the untouched base (the update not merged at all)', () => {
    expect(pathHoldsUpdate({ want: b(UPDATE), base: b(BASE), have: b(BASE) })).toBe(false);
  });

  it('ignores blank added lines; CRLF and LF lines compare equal', () => {
    const want = 'line one\nline two\n\n   \nadded by staff\n';
    const have = 'line one\r\nline two\r\nadded by staff\r\n';
    expect(pathHoldsUpdate({ want: b(want), base: b(BASE), have: b(have) })).toBe(true);
  });

  it('a created file (no base) holds when every line is present', () => {
    expect(pathHoldsUpdate({ want: b('a\nb\n'), base: null, have: b('a\nowner\nb\n') })).toBe(true);
    expect(pathHoldsUpdate({ want: b('a\nb\n'), base: null, have: b('a\n') })).toBe(false);
  });

  it('a file the tree lacks never holds a create or an update', () => {
    expect(pathHoldsUpdate({ want: b(UPDATE), base: b(BASE), have: null })).toBe(false);
    expect(pathHoldsUpdate({ want: b('new\n'), base: null, have: null })).toBe(false);
  });

  it('a delete holds only when the path is gone', () => {
    expect(pathHoldsUpdate({ want: null, base: b(BASE), have: null })).toBe(true);
    expect(pathHoldsUpdate({ want: null, base: b(BASE), have: b(BASE) })).toBe(false);
    expect(pathHoldsUpdate({ want: null, base: b(BASE), have: b('owner rewrote it\n') })).toBe(
      false
    );
  });

  it('an update that only removes lines holds when the file differs from the base', () => {
    const want = 'line one\n';
    expect(pathHoldsUpdate({ want: b(want), base: b(BASE), have: b('line one\nowner\n') })).toBe(
      true
    );
    expect(pathHoldsUpdate({ want: b(want), base: b(BASE), have: b(BASE) })).toBe(false);
  });

  // The update's change is COUNTED: lines it adds and lines it removes, each with its number of
  // copies. Each case below read "contained" under a set-of-lines rule.
  describe('counted changes (added and removed lines)', () => {
    const holds = (want: string, base: string | null, have: string) =>
      pathHoldsUpdate({ want: b(want), base: base === null ? null : b(base), have: b(have) });

    it('a remove-only update whose removed line the owner kept is missing', () => {
      const base = 'keep\nbad call\n';
      const want = 'keep\n';
      // The owner's other edits make the file differ from the base, but the bad line is still there.
      expect(holds(want, base, 'keep\nbad call\nowner edit\n')).toBe(false);
      // Positive control: removed, with the owner's edit beside it.
      expect(holds(want, base, 'keep\nowner edit\n')).toBe(true);
    });

    it('a replacement whose old line the owner kept beside the new one is missing', () => {
      const base = 'a\nold();\nz\n';
      const want = 'a\nnew();\nz\n';
      expect(holds(want, base, 'a\nold();\nnew();\nz\n')).toBe(false);
      expect(holds(want, base, 'a\nnew();\nz\nowner\n')).toBe(true);
    });

    it('an added copy of a line the base already has must be there as a copy', () => {
      const base = 'init();\nrun();\n';
      const want = 'init();\nrun();\ninit();\n';
      // One `init();` (the base's): the update's second copy was never added.
      expect(holds(want, base, 'init();\nrun();\nowner();\n')).toBe(false);
      expect(holds(want, base, 'init();\nrun();\nowner();\ninit();\n')).toBe(true);
    });

    it('a reorder-only update holds with the exact bytes alone', () => {
      const base = 'first\nsecond\n';
      const want = 'second\nfirst\n';
      expect(holds(want, base, want)).toBe(true);
      // The owner's other edits beside the base order: nothing shows the reorder was taken.
      expect(holds(want, base, 'first\nsecond\nowner\n')).toBe(false);
      // Even with the update's order and an owner edit: a reorder is never hand-merged.
      expect(holds(want, base, 'second\nfirst\nowner\n')).toBe(false);
      // Blank-line-only change: also exact bytes only.
      expect(holds('first\n\nsecond\n', base, 'first\nsecond\nowner\n')).toBe(false);
    });

    it('a hand-merge with extra owner edits on both sides of the update holds', () => {
      const base = 'import a;\nold();\nend();\n';
      const want = 'import a;\nimport b;\nnew();\nend();\n';
      const have = '// owner\nimport a;\nimport b;\nimport own;\nnew();\nown();\nend();\n';
      expect(holds(want, base, have)).toBe(true);
    });

    it('CRLF against LF holds (line endings are not a change)', () => {
      const base = 'a\nold\n';
      const want = 'a\nnew\n';
      expect(holds(want, base, 'a\r\nnew\r\nowner\r\n')).toBe(true);
      expect(holds(want, base, 'a\r\nold\r\nnew\r\n')).toBe(false);
    });

    it('a line removed from two copies to one: the owner may keep one, not two', () => {
      const base = 'x();\nx();\ny();\n';
      const want = 'x();\ny();\n';
      expect(holds(want, base, 'x();\ny();\nowner\n')).toBe(true);
      expect(holds(want, base, 'x();\nx();\ny();\nowner\n')).toBe(false);
    });
  });

  it('a non-text file must match exactly', () => {
    const want = Buffer.concat([NOT_UTF8, b('v2')]);
    expect(pathHoldsUpdate({ want, base: NOT_UTF8, have: Buffer.from(want) })).toBe(true);
    expect(pathHoldsUpdate({ want, base: NOT_UTF8, have: Buffer.concat([want, b('x')]) })).toBe(
      false
    );
    // Text that contains every "line" of a binary update still does not hold it.
    expect(pathHoldsUpdate({ want: b(UPDATE), base: b(BASE), have: NOT_UTF8 })).toBe(false);
  });
});

describe('missingUpdatePaths', () => {
  it('lists the paths that do not hold, in the record’s order', async () => {
    const sides: Record<string, Parameters<typeof pathHoldsUpdate>[0]> = {
      'b.ts': { want: b(UPDATE), base: b(BASE), have: b(BASE) },
      'a.ts': { want: b(UPDATE), base: b(BASE), have: b(UPDATE) },
      'gone.ts': { want: null, base: b(BASE), have: b(BASE) },
    };
    const missing = await missingUpdatePaths(
      [{ path: 'b.ts' }, { path: 'a.ts' }, { path: 'gone.ts' }],
      async (path) => sides[path]
    );
    expect(missing).toEqual(['b.ts', 'gone.ts']);
  });
});
