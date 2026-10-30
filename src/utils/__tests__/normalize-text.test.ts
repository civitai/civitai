import { describe, expect, it, vi } from 'vitest';

// These cases pin the decision recorded in normalize-text.ts rather than re-deriving it here.
describe('normalizeText HTML-entity decoding', () => {
  it('decodes on the FIRST call in a fresh module instance', async () => {
    vi.resetModules();
    const { normalizeText } = await import('~/utils/normalize-text');

    expect(normalizeText('red &amp; blue')).toBe('red & blue');
  });

  // The post-await read is the only assertion in this file that can see a decoder which is
  // correct on the first call and wrong later - one that releases the entity table when it
  // goes cold, which is the shape bundle pressure takes once lazy loading is closed off. A
  // measured eviction mutant (correct on load, identity after 5ms) reddens this case and passes
  // the other three. Do not collapse the two reads into `after === before`: that form passes
  // when a decoder warms up only after the wait and both reads are undecoded.
  // `vi.resetModules()` is load-bearing here specifically, since the window only exists in a
  // module instance that has not warmed yet.
  it('decodes on both sides of an await, so two callers cannot disagree', async () => {
    vi.resetModules();
    const { normalizeText } = await import('~/utils/normalize-text');

    const beforeAwait = normalizeText('red &amp; blue');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const afterAwait = normalizeText('red &amp; blue');

    expect(beforeAwait).toBe('red & blue');
    expect(afterAwait).toBe('red & blue');
  });

  // Pins THIS module, not `he`: decoding runs BEFORE the accent fold, covers numeric and hex
  // references, and is single-pass.
  // Keep the four inputs in ONE case against ONE module instance. Split into a case each and
  // every one becomes a first-call-in-a-fresh-instance, which a decoder that memoized its last
  // result would satisfy every time.
  it('decodes before folding accents, handles numeric and hex refs, and does not re-decode', async () => {
    vi.resetModules();
    const { normalizeText } = await import('~/utils/normalize-text');

    expect(normalizeText('&eacute;clair')).toBe('eclair');
    expect(normalizeText('&#38;')).toBe('&');
    expect(normalizeText('&#x26;')).toBe('&');
    expect(normalizeText('&amp;amp;')).toBe('&amp;');
  });

  // Callers pass optional prompt fields straight in, so absent input has to come back as a
  // string rather than as the value it was handed.
  it('returns an empty string for absent input', async () => {
    vi.resetModules();
    const { normalizeText } = await import('~/utils/normalize-text');

    expect(normalizeText(undefined)).toBe('');
    expect(normalizeText('')).toBe('');
  });
});
