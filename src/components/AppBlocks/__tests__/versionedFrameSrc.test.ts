import { describe, expect, test } from 'vitest';
import { versionedFrameSrc } from '../versionedFrameSrc';

// A sha with letters and digits, distinct from anything else here.
const SHA = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
const ROOT = 'https://my-app.civit.ai/';

describe('versionedFrameSrc', () => {
  test('flag on + a full sha: the canonical root src gains /v/<sha>/, origin unchanged', () => {
    expect(versionedFrameSrc(ROOT, SHA, true)).toBe(`https://my-app.civit.ai/v/${SHA}/`);
    expect(new URL(versionedFrameSrc(ROOT, SHA, true)).origin).toBe(new URL(ROOT).origin);
    // The URL parser normalises a bare-origin src to `/` first.
    expect(versionedFrameSrc('https://my-app.civit.ai', SHA, true)).toBe(
      `https://my-app.civit.ai/v/${SHA}/`
    );
  });

  test('flag off: unchanged', () => {
    expect(versionedFrameSrc(ROOT, SHA, false)).toBe(ROOT);
  });

  test('no usable sha: unchanged', () => {
    for (const sha of [
      null,
      undefined,
      '',
      SHA.slice(1),
      `${SHA}0`,
      SHA.toUpperCase(),
      'g'.repeat(40),
    ]) {
      expect(versionedFrameSrc(ROOT, sha, true), String(sha)).toBe(ROOT);
    }
  });

  test('anything but the canonical published root: unchanged', () => {
    for (const src of [
      'https://my-app.civit.ai/?dev=tok', // a dev-tunnel / preview entry URL carries a token
      'https://my-app.civit.ai/#x',
      'https://my-app.civit.ai/sub/',
      `https://my-app.civit.ai/v/${SHA}/`, // never doubled
      'http://my-app.civit.ai/',
      'https://my-app.civit.ai:8443/',
      'https://u:p@my-app.civit.ai/',
      'https://review-0123456789abcdef.civit.ai/',
      'not a url',
      '',
    ]) {
      expect(versionedFrameSrc(src, SHA, true), src).toBe(src);
    }
  });
});
