import { describe, expect, it } from 'vitest';

import {
  submitExternalListingSchema,
  updateListingPatchSchema,
} from '~/server/schema/blocks/offsite-listing.schema';
import {
  ALL_SCOPES,
  SCOPE_JUSTIFICATION_MAX_LENGTH,
  TokenScope,
} from '~/shared/constants/token-scope.constants';

/**
 * W13 external-app submit + patch schema tests — the OAuth-client (connect) FIELDS on the MERGED submitExternalListingSchema. The schema bounds the SHAPE
 * (types + per-value lengths); the subset-of-ceiling + key/justification rules live
 * in the service (they need the client's `allowedScopes`).
 */

const valid = {
  slug: 'connect-app',
  name: 'Connect App',
  connectClientId: 'oauth-client-1',
  requestedScopes: 4,
  scopeJustifications: { ModelsRead: 'reason' },
  contentRating: 'g' as const,
};

describe('submitExternalListingSchema', () => {
  it('accepts a well-formed connect submission', () => {
    const parsed = submitExternalListingSchema.parse(valid);
    expect(parsed.connectClientId).toBe('oauth-client-1');
    expect(parsed.requestedScopes).toBe(4);
    expect(parsed.scopeJustifications).toEqual({ ModelsRead: 'reason' });
  });

  it('defaults contentRating to g when omitted', () => {
    const { contentRating, ...rest } = valid;
    expect(submitExternalListingSchema.parse(rest).contentRating).toBe('g');
  });

  it('accepts an empty justification map', () => {
    expect(submitExternalListingSchema.parse({ ...valid, scopeJustifications: {} })).toBeTruthy();
  });

  it('rejects a missing connectClientId', () => {
    const { connectClientId, ...rest } = valid;
    expect(submitExternalListingSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a negative requestedScopes', () => {
    expect(submitExternalListingSchema.safeParse({ ...valid, requestedScopes: -1 }).success).toBe(
      false
    );
  });

  it('rejects a non-integer requestedScopes', () => {
    expect(submitExternalListingSchema.safeParse({ ...valid, requestedScopes: 1.5 }).success).toBe(
      false
    );
  });

  // int4-overflow hardening: a value beyond the full defined scope set must be
  // rejected at the schema boundary (400), NOT survive the JS-ToInt32 subset check
  // and 500 on the int4 INSERT. These FAIL without the `.max(ALL_SCOPES)` bound.
  it.each([
    ['2**32', 2 ** 32],
    ['2**32 + a real bit', 2 ** 32 + TokenScope.ModelsRead],
  ])('rejects an over-int4 requestedScopes (%s)', (_label, requestedScopes) => {
    expect(
      submitExternalListingSchema.safeParse({ ...valid, requestedScopes, scopeJustifications: {} })
        .success
    ).toBe(false);
  });

  it('accepts requestedScopes at exactly ALL_SCOPES (the max bound)', () => {
    expect(
      submitExternalListingSchema.safeParse({
        ...valid,
        requestedScopes: ALL_SCOPES,
        scopeJustifications: {},
      }).success
    ).toBe(true);
  });

  it('accepts an app-block bit within ALL_SCOPES (Full would have been too strict)', () => {
    // AppBlocksSubmit (bit 25) is EXCLUDED from TokenScope.Full but included in
    // ALL_SCOPES — a client whose allowedScopes carries it can request it.
    expect(
      submitExternalListingSchema.safeParse({
        ...valid,
        requestedScopes: TokenScope.AppBlocksSubmit,
        scopeJustifications: {},
      }).success
    ).toBe(true);
  });

  it('rejects a justification value over the max length', () => {
    const parsed = submitExternalListingSchema.safeParse({
      ...valid,
      scopeJustifications: { ModelsRead: 'x'.repeat(SCOPE_JUSTIFICATION_MAX_LENGTH + 1) },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a justification value at exactly the max length', () => {
    const parsed = submitExternalListingSchema.safeParse({
      ...valid,
      scopeJustifications: { ModelsRead: 'x'.repeat(SCOPE_JUSTIFICATION_MAX_LENGTH) },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('updateListingPatchSchema (connect fields)', () => {
  it('accepts a scope-only patch', () => {
    const parsed = updateListingPatchSchema.parse({
      requestedScopes: 4,
      scopeJustifications: { ModelsRead: 'reason' },
    });
    expect(parsed.requestedScopes).toBe(4);
  });

  it('rejects an over-long justification in a patch', () => {
    expect(
      updateListingPatchSchema.safeParse({
        requestedScopes: 4,
        scopeJustifications: { ModelsRead: 'x'.repeat(SCOPE_JUSTIFICATION_MAX_LENGTH + 1) },
      }).success
    ).toBe(false);
  });

  it('rejects an over-int4 requestedScopes in a patch', () => {
    expect(
      updateListingPatchSchema.safeParse({ requestedScopes: 2 ** 32, scopeJustifications: {} })
        .success
    ).toBe(false);
  });

  it('accepts requestedScopes at ALL_SCOPES in a patch', () => {
    expect(
      updateListingPatchSchema.safeParse({ requestedScopes: ALL_SCOPES }).success
    ).toBe(true);
  });
});
