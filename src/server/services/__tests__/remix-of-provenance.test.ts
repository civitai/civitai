import { describe, expect, it } from 'vitest';
import { getRemixSourceIds } from '~/server/services/image.service';

/**
 * What the "Remixed from" card is allowed to treat as provenance.
 *
 * The decision this pins is a product ruling, not an implementation detail, so
 * it is pinned by NAME rather than as a spec bullet: a test called "reads only
 * sourceImageIds" gets "corrected" along with the code by the next person who
 * notices the two fields and unions them, which is a reasonable-looking change
 * that halves nothing visible and quietly restores a spoofable attribution.
 *
 * The evidence for the ruling already exists upstream:
 * `orchestrator/__tests__/remix-provenance.test.ts:224` demonstrates in one
 * assertion that an unverified `sourceImageIds` is stripped on write while
 * `remixOfId` survives untouched — a working demonstration that one field is
 * client-writable and the other is not.
 *
 * ⚠️ This pins the FUNCTION, not the call site. Someone can leave
 * `getRemixSourceIds` alone and add `?? meta?.extra?.remixOfId` where
 * `remixOfIds` is assembled in `getImageGenerationData`, and every test below
 * stays green. Pinning the decision itself would take a read-side convention
 * guard modelled on `no-unverified-provenance-write.test.ts`.
 */
describe('getRemixSourceIds', () => {
  it('ignores meta.extra.remixOfId — client-declared, unverifiable, ruled out 2026-08-27', () => {
    expect(getRemixSourceIds(1, { extra: { remixOfId: 9 } } as never)).toEqual([]);
  });

  // The control that makes the assertion above capable of failing. Alone, it
  // passes for a function that returns [] unconditionally; beside this one, it
  // can only pass for a function that reads one field and not the other.
  it('reads sourceImageIds on a row carrying both fields', () => {
    expect(getRemixSourceIds(1, { extra: { remixOfId: 9, sourceImageIds: [4] } } as never)).toEqual(
      [4]
    );
  });

  it('drops a self-reference rather than rendering the image as its own source', () => {
    expect(getRemixSourceIds(5, { extra: { sourceImageIds: [5] } })).toEqual([]);
  });

  it('shows a repeated source once', () => {
    expect(getRemixSourceIds(1, { extra: { sourceImageIds: [7, 7] } })).toEqual([7]);
  });

  it('returns empty for meta with no extra, rather than throwing', () => {
    expect(getRemixSourceIds(1, {})).toEqual([]);
    expect(getRemixSourceIds(1, null)).toEqual([]);
    expect(getRemixSourceIds(1, undefined)).toEqual([]);
  });

  /**
   * The fan-out bound the card's `trpc.useQueries` depends on.
   *
   * `sanitizeProvenance` writes `verified` VERBATIM — MAX_SOURCE_IMAGES is
   * applied by the resolvers that produce it, not by the sink — so a stored row
   * carries no bound of its own and the read path is the only thing standing
   * between a bad row and one tRPC query per element on the image detail page.
   */
  it('caps the fan-out at MAX_SOURCE_IMAGES, because a stored row is not bounded', () => {
    const many = Array.from({ length: 20 }, (_, i) => i + 100);
    expect(getRemixSourceIds(1, { extra: { sourceImageIds: many } })).toHaveLength(8);
  });
});
