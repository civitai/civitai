import { describe, expect, it } from 'vitest';
import { replaceAngleTags, tagSegments } from '~/server/services/resource-intent-tags/extract';

/**
 * `replaceAngleTags` replaced the regex `/<[^>]*>/gu` (replacement `,`) in `tagSegments`, whose
 * expected values the parity fixture took from the prototype. The scan must produce the regex's
 * output byte for byte, and must not be quadratic in a run of `<`.
 */
const regexReplace = (s: string) => s.replace(/<[^>]*>/gu, ',');

/** mulberry32: a seeded PRNG, so a failing corpus string is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ['<', '<', '<', '>', '>', 'a', 'b', ' ', ',', '\n', 'é', '\u{20000}', ':', '1'];

const ADVERSARIAL = [
  '',
  '<',
  '>',
  '<>',
  '><',
  '<<a>',
  '<a<b>',
  '<a>>',
  '<<>>',
  '<a><b>',
  'x<a>y<b>z',
  'tail <unterminated',
  '<a> then <unterminated',
  '<unterminated then <a>',
  '<lora:Foo_Bar:0.8> (watercolor:1.2), <hypernet:x:1>',
  '<'.repeat(50),
  '<'.repeat(50) + '>',
  '>'.repeat(10) + '<'.repeat(10),
  '<\u{20000}>\u{20000}<é',
  '<a\nb>c',
];

describe('replaceAngleTags equals the regex it replaced', () => {
  it.each(ADVERSARIAL.map((s) => [JSON.stringify(s).slice(0, 40), s] as const))(
    'adversarial %s',
    (_label, s) => {
      expect(replaceAngleTags(s)).toBe(regexReplace(s));
    }
  );

  it('on 5,000 random strings over an angle-heavy alphabet', () => {
    const next = rng(20261015);
    let differing = 0;
    let changed = 0;
    for (let n = 0; n < 5000; n++) {
      const len = Math.floor(next() * 40);
      let s = '';
      for (let k = 0; k < len; k++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
      const want = regexReplace(s);
      if (want !== s) changed++;
      if (replaceAngleTags(s) !== want) differing++;
    }
    expect(differing).toBe(0);
    // Positive control: the corpus exercises the replacement, not only strings without a tag.
    expect(changed).toBeGreaterThan(2000);
  });
});

describe('the angle-tag strip is linear in a run of `<`', () => {
  const time = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };

  it('a 6,000-character prompt of `<` is extracted in well under 50 ms', () => {
    const p = '<'.repeat(6000);
    tagSegments('<warm-up>');
    expect(time(() => tagSegments(p))).toBeLessThan(50);
  });

  it('a 100,000-character prompt of `<` is extracted in well under 50 ms (the regex took seconds)', () => {
    const p = '<'.repeat(100_000);
    tagSegments('<warm-up>');
    expect(time(() => tagSegments(p))).toBeLessThan(50);
  });
});
