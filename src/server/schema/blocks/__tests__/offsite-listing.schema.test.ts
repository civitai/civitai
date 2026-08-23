import { describe, expect, it } from 'vitest';

import {
  MAX_EXTERNAL_URL_LENGTH,
  MAX_REPOSITORY_URL_LENGTH,
} from '~/server/schema/blocks/external-app.schema';
import {
  OFFSITE_DESCRIPTION_MAX,
  approveExternalRequestSchema,
  rejectExternalRequestSchema,
  submitExternalListingSchema,
  updateListingPatchSchema,
} from '~/server/schema/blocks/offsite-listing.schema';

/**
 * App Store Listings (W13) — external-app submission INPUT validation (the MERGED
 * external+connect model — every external app links its own OAuth client).
 *
 * Pins the submit-schema gates: REQUIRED `connectClientId`, OPTIONAL https external
 * URL (delegated to the shared `validateExternalUrl` only when present), slug shape,
 * name/description bounds, taxonomy category, author-declared contentRating (default
 * SFW), optional changelog, and the external ⟂ on-platform mutual-exclusivity (a
 * page/targets/iframe field is REJECTED, not silently dropped).
 */

const base = {
  slug: 'cool-app',
  name: 'Cool App',
  externalUrl: 'https://cool.example.com/app',
  // REQUIRED in the merged model — every external app links an OAuth client.
  connectClientId: 'oauth-client-1',
  requestedScopes: 0,
  scopeJustifications: {},
};

describe('submitExternalListingSchema — happy path', () => {
  it('accepts a well-formed https submission (minimal)', () => {
    const parsed = submitExternalListingSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    // contentRating defaults to SFW when omitted.
    if (parsed.success) expect(parsed.data.contentRating).toBe('g');
  });

  it('REQUIRES connectClientId (missing → reject)', () => {
    const { connectClientId, ...rest } = base;
    expect(submitExternalListingSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts a submission WITHOUT externalUrl (optional homepage link)', () => {
    const { externalUrl, ...rest } = base;
    const parsed = submitExternalListingSchema.safeParse(rest);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.externalUrl).toBeUndefined();
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

  it('accepts a reason at the unified mod-reason ceiling (OFFSITE_MOD_REASON_MAX=1000)', () => {
    expect(
      rejectExternalRequestSchema.safeParse({
        publishRequestId: 'alpr_1',
        rejectionReason: 'x'.repeat(1000),
      }).success
    ).toBe(true);
  });

  it('rejects an over-long reason (>1000, the unified mod-reason ceiling)', () => {
    expect(
      rejectExternalRequestSchema.safeParse({
        publishRequestId: 'alpr_1',
        rejectionReason: 'x'.repeat(1001),
      }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SOURCE REPOSITORY — the submit + patch schema boundaries
// ---------------------------------------------------------------------------

describe('sourceRepoUrl at the schema boundary', () => {
  it('is OPTIONAL — omitting it parses (positive control for every reject below)', () => {
    const parsed = submitExternalListingSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sourceRepoUrl).toBeUndefined();
  });

  it('accepts a repository root on each allowlisted host', () => {
    for (const sourceRepoUrl of [
      'https://github.com/o/r',
      'https://gitlab.com/o/r',
      'https://codeberg.org/o/r',
      'https://github.com/o/r.git',
    ]) {
      const parsed = submitExternalListingSchema.safeParse({ ...base, sourceRepoUrl });
      expect(parsed.success, sourceRepoUrl).toBe(true);
    }
  });

  it.each([
    ['http', 'http://github.com/o/r'],
    ['a non-allowlisted host', 'https://gist.github.com/o/deadbeef'],
    ['raw.githubusercontent.com', 'https://raw.githubusercontent.com/o/r/main/x.sh'],
    ['www.', 'https://www.github.com/o/r'],
    ['the host root', 'https://github.com'],
    ['a deep path', 'https://github.com/o/r/tree/main'],
    ['credentials', 'https://u:p@github.com/o/r'],
  ])('REJECTS %s at the submit boundary, on the sourceRepoUrl path', (_label, sourceRepoUrl) => {
    const parsed = submitExternalListingSchema.safeParse({ ...base, sourceRepoUrl });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // The issue must be attributed to THIS field — a generic form-level error would
    // leave the wizard unable to point at the input that is wrong.
    expect(parsed.error.issues.some((i) => i.path.join('.') === 'sourceRepoUrl')).toBe(true);
  });

  it('rejects an over-length value (the repository bound, not the external-URL one)', () => {
    const long = 'https://github.com/o/' + 'r'.repeat(MAX_REPOSITORY_URL_LENGTH);
    expect(long.length).toBeGreaterThan(MAX_REPOSITORY_URL_LENGTH);
    expect(long.length).toBeLessThan(MAX_EXTERNAL_URL_LENGTH);
    const parsed = submitExternalListingSchema.safeParse({ ...base, sourceRepoUrl: long });
    expect(parsed.success).toBe(false);
  });
});

describe('updateListingPatchSchema — sourceRepoUrl is NULLABLE-optional', () => {
  it('OMITTED is allowed (as long as some other field is present)', () => {
    const parsed = updateListingPatchSchema.safeParse({ name: 'Renamed' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('sourceRepoUrl' in parsed.data).toBe(false);
  });

  it('an explicit NULL is allowed — and on its own satisfies the at-least-one-field refine', () => {
    // This is how the field is CLEARED. If `null` were not accepted, the only way to
    // remove a published link would be to also change something else.
    const parsed = updateListingPatchSchema.safeParse({ sourceRepoUrl: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sourceRepoUrl).toBeNull();
  });

  it('a value is accepted here and re-validated in the SERVICE (this bound is coarse)', () => {
    // The patch schema deliberately bounds only the SHAPE — `buildListingPatchData`
    // runs the real rule, so an invalid-but-short value parses here and is rejected
    // there. Pinning that division stops someone "fixing" it in one place only.
    expect(
      updateListingPatchSchema.safeParse({ sourceRepoUrl: 'https://github.com/o/r' }).success
    ).toBe(true);
    expect(
      updateListingPatchSchema.safeParse({ sourceRepoUrl: 'http://evil.example/x' }).success
    ).toBe(true);
  });

  it('rejects an over-length value and an empty string', () => {
    expect(
      updateListingPatchSchema.safeParse({
        sourceRepoUrl: 'https://github.com/o/' + 'r'.repeat(MAX_REPOSITORY_URL_LENGTH),
      }).success
    ).toBe(false);
    expect(updateListingPatchSchema.safeParse({ sourceRepoUrl: '' }).success).toBe(false);
  });
});
