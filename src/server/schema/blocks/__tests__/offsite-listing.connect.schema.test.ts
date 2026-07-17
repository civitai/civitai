import { describe, expect, it } from 'vitest';

import {
  submitConnectListingSchema,
  updateListingPatchSchema,
} from '~/server/schema/blocks/offsite-listing.schema';
import { SCOPE_JUSTIFICATION_MAX_LENGTH } from '~/shared/constants/token-scope.constants';

/**
 * W13 OAuth-connect submit + patch schema tests (PR2). The schema bounds the SHAPE
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

describe('submitConnectListingSchema', () => {
  it('accepts a well-formed connect submission', () => {
    const parsed = submitConnectListingSchema.parse(valid);
    expect(parsed.connectClientId).toBe('oauth-client-1');
    expect(parsed.requestedScopes).toBe(4);
    expect(parsed.scopeJustifications).toEqual({ ModelsRead: 'reason' });
  });

  it('defaults contentRating to g when omitted', () => {
    const { contentRating, ...rest } = valid;
    expect(submitConnectListingSchema.parse(rest).contentRating).toBe('g');
  });

  it('accepts an empty justification map', () => {
    expect(submitConnectListingSchema.parse({ ...valid, scopeJustifications: {} })).toBeTruthy();
  });

  it('rejects a missing connectClientId', () => {
    const { connectClientId, ...rest } = valid;
    expect(submitConnectListingSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a negative requestedScopes', () => {
    expect(submitConnectListingSchema.safeParse({ ...valid, requestedScopes: -1 }).success).toBe(
      false
    );
  });

  it('rejects a non-integer requestedScopes', () => {
    expect(submitConnectListingSchema.safeParse({ ...valid, requestedScopes: 1.5 }).success).toBe(
      false
    );
  });

  it('rejects a justification value over the max length', () => {
    const parsed = submitConnectListingSchema.safeParse({
      ...valid,
      scopeJustifications: { ModelsRead: 'x'.repeat(SCOPE_JUSTIFICATION_MAX_LENGTH + 1) },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a justification value at exactly the max length', () => {
    const parsed = submitConnectListingSchema.safeParse({
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
});
