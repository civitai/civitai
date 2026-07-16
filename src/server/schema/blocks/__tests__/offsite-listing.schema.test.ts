import { describe, expect, it } from 'vitest';

import { MAX_EXTERNAL_URL_LENGTH } from '~/server/schema/blocks/external-app.schema';
import {
  OFFSITE_DESCRIPTION_MAX,
  approveExternalRequestSchema,
  rejectExternalRequestSchema,
  submitExternalListingSchema,
} from '~/server/schema/blocks/offsite-listing.schema';

/**
 * App Store Listings (W13 P3a) — off-site submission INPUT validation.
 *
 * Pins the submit-schema gates: https-only external URL (delegated to the shared
 * `validateExternalUrl`), slug shape, name/description bounds, taxonomy category,
 * author-declared contentRating (default SFW), optional changelog, and the
 * external ⟂ on-platform mutual-exclusivity (a page/targets/iframe field is
 * REJECTED, not silently dropped).
 */

const base = {
  slug: 'cool-app',
  name: 'Cool App',
  externalUrl: 'https://cool.example.com/app',
};

describe('submitExternalListingSchema — happy path', () => {
  it('accepts a well-formed https submission (minimal)', () => {
    const parsed = submitExternalListingSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    // contentRating defaults to SFW when omitted.
    if (parsed.success) expect(parsed.data.contentRating).toBe('g');
  });

  it('accepts a full submission (tagline/description/category/changelog/rating)', () => {
    const parsed = submitExternalListingSchema.safeParse({
      ...base,
      tagline: 'a cool off-site app',
      description: 'longer body',
      category: 'utility',
      contentRating: 'pg13',
      changelog: 'v1 launch',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.contentRating).toBe('pg13');
  });

  it('changelog is optional', () => {
    expect(submitExternalListingSchema.safeParse(base).success).toBe(true);
  });
});

describe('submitExternalListingSchema — externalUrl (delegates to validateExternalUrl)', () => {
  it('REJECTS a non-https (http) URL', () => {
    const r = submitExternalListingSchema.safeParse({ ...base, externalUrl: 'http://x.com' });
    expect(r.success).toBe(false);
  });

  it('REJECTS dangerous schemes (javascript / data)', () => {
    for (const externalUrl of ['javascript:alert(1)', 'data:text/html,<b>x</b>']) {
      expect(submitExternalListingSchema.safeParse({ ...base, externalUrl }).success).toBe(false);
    }
  });

  it('REJECTS an empty URL', () => {
    expect(submitExternalListingSchema.safeParse({ ...base, externalUrl: '' }).success).toBe(false);
  });

  it('REJECTS an over-long URL (>2048 chars)', () => {
    const long = 'https://example.com/' + 'a'.repeat(MAX_EXTERNAL_URL_LENGTH);
    expect(submitExternalListingSchema.safeParse({ ...base, externalUrl: long }).success).toBe(false);
  });
});

describe('submitExternalListingSchema — slug / name / category / description', () => {
  it('REJECTS a malformed slug (uppercase / leading digit / too short / underscore)', () => {
    for (const slug of ['Cool', '1app', 'ab', 'a_b', '-app']) {
      expect(
        submitExternalListingSchema.safeParse({ ...base, slug }).success,
        `slug "${slug}"`
      ).toBe(false);
    }
  });

  it('REJECTS an empty name and an over-long name', () => {
    expect(submitExternalListingSchema.safeParse({ ...base, name: '' }).success).toBe(false);
    expect(
      submitExternalListingSchema.safeParse({ ...base, name: 'x'.repeat(121) }).success
    ).toBe(false);
  });

  it('REJECTS an unknown category (must be in the taxonomy)', () => {
    expect(
      submitExternalListingSchema.safeParse({ ...base, category: 'not-a-category' }).success
    ).toBe(false);
  });

  it('accepts a known taxonomy category', () => {
    expect(submitExternalListingSchema.safeParse({ ...base, category: 'games' }).success).toBe(true);
  });

  it('REJECTS an over-long description (>2000)', () => {
    expect(
      submitExternalListingSchema.safeParse({
        ...base,
        description: 'x'.repeat(OFFSITE_DESCRIPTION_MAX + 1),
      }).success
    ).toBe(false);
  });
});

describe('submitExternalListingSchema — contentRating', () => {
  it('accepts every valid rating', () => {
    for (const contentRating of ['g', 'pg', 'pg13', 'r', 'x'] as const) {
      expect(
        submitExternalListingSchema.safeParse({ ...base, contentRating }).success,
        contentRating
      ).toBe(true);
    }
  });

  it('REJECTS an unknown rating', () => {
    expect(
      submitExternalListingSchema.safeParse({ ...base, contentRating: 'nc17' }).success
    ).toBe(false);
  });
});

describe('submitExternalListingSchema — external ⟂ on-platform mutual exclusivity', () => {
  it('REJECTS a submission declaring a page surface', () => {
    expect(
      submitExternalListingSchema.safeParse({ ...base, page: { path: '/run' } }).success
    ).toBe(false);
  });

  it('REJECTS a submission declaring target slots', () => {
    expect(
      submitExternalListingSchema.safeParse({
        ...base,
        targets: [{ slotId: 'model.sidebar_top' }],
      }).success
    ).toBe(false);
  });

  it('REJECTS a submission declaring an iframe surface', () => {
    expect(
      submitExternalListingSchema.safeParse({ ...base, iframe: { src: 'https://x.civit.ai' } })
        .success
    ).toBe(false);
  });

  it('an EMPTY targets array declares nothing → accepted', () => {
    expect(submitExternalListingSchema.safeParse({ ...base, targets: [] }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// approve / reject input schemas (PR-b) — mirror the on-site shapes.
// ---------------------------------------------------------------------------

describe('approveExternalRequestSchema', () => {
  it('accepts a bare publishRequestId', () => {
    expect(approveExternalRequestSchema.safeParse({ publishRequestId: 'alpr_1' }).success).toBe(true);
  });

  it('accepts an optional approvalNotes', () => {
    expect(
      approveExternalRequestSchema.safeParse({ publishRequestId: 'alpr_1', approvalNotes: 'ok' })
        .success
    ).toBe(true);
  });

  it('rejects an empty publishRequestId', () => {
    expect(approveExternalRequestSchema.safeParse({ publishRequestId: '' }).success).toBe(false);
  });

  it('rejects over-long approvalNotes (>2000)', () => {
    expect(
      approveExternalRequestSchema.safeParse({
        publishRequestId: 'alpr_1',
        approvalNotes: 'x'.repeat(2001),
      }).success
    ).toBe(false);
  });
});

describe('rejectExternalRequestSchema', () => {
  it('accepts a reason ≥ the shared min (OFFSITE_MOD_REASON_MIN=3)', () => {
    expect(
      rejectExternalRequestSchema.safeParse({
        publishRequestId: 'alpr_1',
        rejectionReason: 'spam listing, not a real app',
      }).success
    ).toBe(true);
  });

  it('rejects a reason shorter than the shared min (OFFSITE_MOD_REASON_MIN=3)', () => {
    expect(
      rejectExternalRequestSchema.safeParse({ publishRequestId: 'alpr_1', rejectionReason: 'no' })
        .success
    ).toBe(false);
  });

  it('rejects a missing reason', () => {
    expect(rejectExternalRequestSchema.safeParse({ publishRequestId: 'alpr_1' }).success).toBe(false);
  });

  it('rejects an over-long reason (>2000)', () => {
    expect(
      rejectExternalRequestSchema.safeParse({
        publishRequestId: 'alpr_1',
        rejectionReason: 'x'.repeat(2001),
      }).success
    ).toBe(false);
  });
});
