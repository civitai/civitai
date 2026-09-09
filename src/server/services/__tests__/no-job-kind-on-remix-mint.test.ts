import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Convention guard: the remix mint issues `mint` tokens, never `job` ones.
 *
 * `sourceImageIds` gates the FREE remix-gallery submission and the
 * `derivedFromHost` badge (`remix-gallery.service.ts`). The upload path takes
 * its token from client-supplied `meta.extra.provenance`, so a token that cost
 * no generation must never be spendable there — which is the whole reason
 * `ProvenanceKind` exists.
 *
 * The wiring that enforces it is one argument in one procedure. Changing
 * `kind: 'mint'` to `kind: 'job'` — or dropping the argument, since `job` is the
 * default — re-opens the bypass and leaves every unit test in
 * `remix-provenance.test.ts` green, because those exercise the functions rather
 * than the call. Measured: that mutation passes 37/37.
 *
 * Text-matched rather than exercised because the alternative is a `createCaller`
 * suite standing up an orchestrator context to assert one literal. The failure
 * this catches is an edit to this line, and a matcher over the line is the
 * proportionate instrument. It is deliberately narrow: it says nothing about
 * whether the gate around the mint is right, only that what the mint hands out
 * cannot be spent on the upload path.
 */

const ROUTER = path.resolve(__dirname, '../../routers/orchestrator.router.ts');

describe('remix provenance mint audience', () => {
  it("signs its token as 'mint'", () => {
    const src = fs.readFileSync(ROUTER, 'utf8');

    const handler = src.slice(src.indexOf('mintRemixProvenance:'));
    expect(handler).not.toBe('');

    // The signProvenance call inside the mint handler, up to its closing brace.
    const call = handler.slice(handler.indexOf('signProvenance('));
    const body = call.slice(0, call.indexOf('}),') + 2);

    expect(body).toContain('sourceImageIds: [image.id]');
    expect(body).toMatch(/kind:\s*'mint'/);
  });

  /**
   * The other half of the invariant, and the one a reader is most likely to
   * "simplify": `job` must stay the DEFAULT on verify, so a caller that has not
   * read `remix-provenance.ts` gets the strict answer. The upload path relies on
   * that default rather than passing an audience of its own.
   */
  it("leaves 'job' as the default audience on verifyProvenance", () => {
    const provenance = fs.readFileSync(
      path.resolve(__dirname, '../orchestrator/remix-provenance.ts'),
      'utf8'
    );

    expect(provenance).toMatch(/expect:\s*ProvenanceKind\s*=\s*'job'/);
    // And the submit path is the one place that opts out of it.
    expect(provenance).toMatch(/verifyProvenance\(token,\s*userId,\s*'mint'\)/);
  });
});
