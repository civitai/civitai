import { describe, expect, it, vi } from 'vitest';

// These cases pin the decision recorded in normalize-text.ts rather than re-deriving it here.
// `vi.resetModules()` is what makes them capable of failing at all: a lazily-initialised decoder
// is only ever un-warmed in a fresh module instance.
describe('normalizeText HTML-entity decoding', () => {
  it('decodes on the FIRST call in a fresh module instance', async () => {
    vi.resetModules();
    const { normalizeText } = await import('~/utils/normalize-text');

    expect(normalizeText('red &amp; blue')).toBe('red & blue');
  });

  // Both reads are anchored to the decoded value, not to each other. `after === before` would
  // pass when a decoder warms up only after the wait and both reads are undecoded, which is
  // worse than what this pins. The post-await read is not independently protective, since
  // nothing here can un-warm a decoder; this case earns its place by naming the straddle that
  // the audit paths perform, so a future decoder cannot satisfy it by warming up late.
  it('decodes on both sides of an await, so two callers cannot disagree', async () => {
    vi.resetModules();
    const { normalizeText } = await import('~/utils/normalize-text');

    const beforeAwait = normalizeText('red &amp; blue');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const afterAwait = normalizeText('red &amp; blue');

    expect(beforeAwait).toBe('red & blue');
    expect(afterAwait).toBe('red & blue');
  });

  // These pin THIS module, not `he`: decoding runs BEFORE the accent fold, it covers numeric and
  // hex references, and it is single-pass. A compact hand-rolled substitute reddens them.
  it('decodes before folding accents, handles numeric and hex refs, and does not re-decode', async () => {
    vi.resetModules();
    const { normalizeText } = await import('~/utils/normalize-text');

    expect(normalizeText('&eacute;clair')).toBe('eclair');
    expect(normalizeText('&#38;')).toBe('&');
    expect(normalizeText('&#x26;')).toBe('&');
    expect(normalizeText('&amp;amp;')).toBe('&amp;');
  });
});
