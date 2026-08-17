import { describe, expect, it } from 'vitest';
import {
  getRemixGalleryFreeEligibilitySchema,
  submitToRemixGallerySchema,
} from '~/server/schema/placement.schema';

describe('getRemixGalleryFreeEligibilitySchema', () => {
  it('bounds the candidate list', () => {
    // The only ceiling on the work: the service runs a jsonb containment test
    // per row, so the cap is what stops one request probing an arbitrary slice
    // of somebody's library. It is a claim the service's own docstring makes
    // about this file, and nothing asserted it.
    const ids = Array.from({ length: 201 }, (_, index) => index + 1);

    expect(
      getRemixGalleryFreeEligibilitySchema.safeParse({ hostImageId: 1, imageIds: ids }).success
    ).toBe(false);
    expect(
      getRemixGalleryFreeEligibilitySchema.safeParse({
        hostImageId: 1,
        imageIds: ids.slice(0, 200),
      }).success
    ).toBe(true);
  });

  it('accepts the empty list the picker opens with', () => {
    // Nothing selected is the modal's first render, and the service answers it
    // without a query at all. A minimum here would make that state an error.
    expect(
      getRemixGalleryFreeEligibilitySchema.safeParse({ hostImageId: 1, imageIds: [] }).success
    ).toBe(true);
  });
});

/**
 * The submission contract, at the boundary where a client's payload becomes an
 * argument.
 *
 * Two things below the schema depend on it and neither can check it: the service
 * reads a missing `expectedPrice` as "the submitter agreed to whatever the price
 * is now", and `createFreePlacement` takes `placerId` as a plain number it
 * cannot trace to a session.
 */
describe('submitToRemixGallerySchema', () => {
  const paid = { hostImageId: 11, imageId: 12, expectedPrice: 100 };

  it('defaults a submission to paid', () => {
    // Asked for, never assumed. A client cached from before the free tier must
    // keep paying rather than start spending an allowance it does not know it
    // has.
    expect(submitToRemixGallerySchema.parse(paid).free).toBe(false);
  });

  it('requires the price a paid submission was shown', () => {
    // The consent check. Without it the service charges whatever the price is at
    // the moment of the click, which is the spend-without-consent case
    // `expectedPrice` exists to prevent — and an owner can move their price at
    // any time.
    const result = submitToRemixGallerySchema.safeParse({ hostImageId: 11, imageId: 12 });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['expectedPrice']);
  });

  it('lets a free submission omit the price it is not paying', () => {
    const result = submitToRemixGallerySchema.safeParse({
      hostImageId: 11,
      imageId: 12,
      free: true,
    });

    expect(result.success).toBe(true);
    expect(result.data?.expectedPrice).toBeUndefined();
  });

  it('strips a client-supplied placerId rather than carrying it', () => {
    // 🔴 The half of the placerId defence that lives in this file. The router
    // spreads `...input` before the session id, so both would have to break for
    // a client value to survive — but a `placerId` accepted here is one of the
    // two, and nothing downstream would catch it: every check in
    // `createFreePlacement` is *about* that id rather than a check *of* it.
    const parsed = submitToRemixGallerySchema.parse({ ...paid, placerId: 999 });

    expect(parsed).not.toHaveProperty('placerId');
  });
});
