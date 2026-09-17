import { describe, expect, it, vi } from 'vitest';

// These two cases pin a DECISION, not an implementation detail: `he` is imported statically in
// normalize-text.ts and must stay that way. Making it lazy again reddens both; that is the point.
// If `he` has to leave the client bundle, its replacement still has to decode on the first call;
// a decoder that warms up asynchronously is not an option for this module, because callers read
// its output synchronously and two of them can straddle an `await`.
//
// `vi.resetModules()` is what makes these tests capable of failing at all: a lazily-initialised
// decoder is only ever un-warmed in a fresh module instance.
describe('normalizeText HTML-entity decoding', () => {
  const input = 'red &amp; blue';
  const decoded = 'red & blue';

  it('decodes entities on the FIRST call in a fresh module instance', async () => {
    vi.resetModules();
    const { normalizeText } = await import('~/utils/normalize-text');

    expect(normalizeText(input)).toBe(decoded);
  });

  it('returns the same text before and after an await, so two callers cannot disagree', async () => {
    vi.resetModules();
    const { normalizeText } = await import('~/utils/normalize-text');

    const beforeAwait = normalizeText(input);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const afterAwait = normalizeText(input);

    expect(afterAwait).toBe(beforeAwait);
  });
});
