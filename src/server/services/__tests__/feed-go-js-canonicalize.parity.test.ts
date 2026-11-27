import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { replaceInsensitive } from '~/utils/string-helpers';

/**
 * feed-go names a model file as `resolveModelFileName` does (`GET /api/v1/models`), and for a model
 * or version name with non-ASCII text that hangs on two things the Node ENGINE decides, not this
 * repo: which code units `replaceInsensitive`'s `new RegExp(…, 'gi')` treats as equal (ECMA-262
 * Canonicalize, which V8 computes with its ICU), and which ones `String.prototype.trim` removes.
 * feed-go reads both from apps/feed-go/internal/v1models/jscanon.json, which
 * apps/feed-go/testdata/golden/gen-v1-filenames.mjs wrote from one Node. This recomputes both in the
 * Node the app runs on: a Node upgrade whose ICU moves a case mapping (or the whitespace set) fails
 * here, and the fix is to rerun that generator, so feed-go names files as the new Node does.
 */
const TABLE = path.resolve(__dirname, '../../../../apps/feed-go/internal/v1models/jscanon.json');

function canonicalize(cu: number) {
  const u = String.fromCharCode(cu).toUpperCase();
  if (u.length !== 1) return cu;
  const c = u.charCodeAt(0);
  if (cu >= 128 && c < 128) return cu;
  return c;
}

describe('feed-go jscanon.json', () => {
  const table = JSON.parse(readFileSync(TABLE, 'utf8')) as {
    canon: [number, number][];
    trim: number[];
  };

  it("is this Node's Canonicalize over every UTF-16 code unit", () => {
    const pairs: [number, number][] = [];
    for (let cu = 0; cu <= 0xffff; cu++) {
      const c = canonicalize(cu);
      if (c !== cu) pairs.push([cu, c]);
    }
    // Positive control: the table is not empty, so equality is not two empty lists agreeing.
    expect(pairs.length).toBeGreaterThan(1000);
    expect(table.canon).toEqual(pairs);
  });

  it("matches this Node's RegExp engine (replaceInsensitive) on every non-identity entry", () => {
    for (const [cu, c] of table.canon) {
      const a = String.fromCharCode(cu);
      const b = String.fromCharCode(c);
      // Digits around it: a digit is its own canonical value, so only the entry itself can match.
      expect(replaceInsensitive(`0${a}1`, b, ''), `U+${cu.toString(16)} vs U+${c.toString(16)}`).toBe('01');
    }
  });

  it("is this Node's String.prototype.trim set", () => {
    const trim: number[] = [];
    for (let cu = 0; cu <= 0xffff; cu++) if (String.fromCharCode(cu).trim() === '') trim.push(cu);
    expect(trim.length).toBeGreaterThan(20);
    expect(table.trim).toEqual(trim);
  });
});
