import { describe, expect, it } from 'vitest';
import { buildErrorFormatOption } from './client';

// Prisma's non-'minimal' errorFormat makes the client capture a stack trace (`new Error`) on every
// model-method call, just to annotate errors with a source location. In production that annotation
// is never rendered (the renderer early-returns on NODE_ENV === 'production'), so the capture is
// pure waste — it was the largest single allocation source in a production SSR allocation profile.
describe('buildErrorFormatOption', () => {
  it("uses 'minimal' in production so Prisma skips the per-call callsite capture", () => {
    expect(buildErrorFormatOption(true)).toEqual({ errorFormat: 'minimal' });
  });

  it('leaves errorFormat at the Prisma default outside production for readable local errors', () => {
    // Must be an ABSENT key, not `errorFormat: undefined` — spreading an explicit `undefined`
    // into the client options would override Prisma's own default.
    const opts = buildErrorFormatOption(false);
    expect(opts).toEqual({});
    expect('errorFormat' in opts).toBe(false);
  });
});
