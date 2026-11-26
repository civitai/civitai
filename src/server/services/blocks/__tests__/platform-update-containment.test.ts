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
