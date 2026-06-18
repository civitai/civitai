import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_METADATA_KEYS,
  blockAttributionSchema,
  deriveScopeFromInstanceId,
  encodeAttributionMetadata,
  extractAttribution,
} from '../attribution.schema';

/**
 * Wire-shape coverage for App Blocks attribution metadata. The
 * encode/extract pair has to round-trip across Stripe's flat
 * Record<string, string> metadata bag — these tests assert that
 * roundtrip plus the prefix→scope resolver used by IframeHost.
 */

describe('deriveScopeFromInstanceId', () => {
  it.each([
    // L-M2: post kill_per_model_installs, mbi_*/bki_* are per-model-PINNED
    // block_user_subscriptions rows whose stored scope is
    // publisher_all_my_models (resolveBlockInstance rejects any other scope
    // for these prefixes). They share the publisher earnings bucket with the
    // blanket bus_pub_* shape rather than the stale per_model_install bucket.
    ['mbi_01HZK', 'publisher_all_my_models'],
    ['bki_01HZK', 'publisher_all_my_models'],
    ['bus_pub_01HZK', 'publisher_all_my_models'],
    ['bus_view_01HZK', 'viewer_personal'],
    ['pdb_01HZK', 'platform_default'],
    // W3 flow B: page surface (W10) → viewer_global. `page_<appBlockId>`.
    ['page_apb_01HZK', 'viewer_global'],
  ] as const)('maps %s to %s', (id, scope) => {
    expect(deriveScopeFromInstanceId(id)).toBe(scope);
  });

  it('maps a page_ instance to viewer_global (flow B) and leaves the others unchanged', () => {
    expect(deriveScopeFromInstanceId('page_apb_xyz')).toBe('viewer_global');
    // The pre-existing prefixes are unchanged by the new branch.
    expect(deriveScopeFromInstanceId('mbi_x')).toBe('publisher_all_my_models');
    expect(deriveScopeFromInstanceId('bki_x')).toBe('publisher_all_my_models');
    expect(deriveScopeFromInstanceId('bus_pub_x')).toBe('publisher_all_my_models');
    expect(deriveScopeFromInstanceId('bus_view_x')).toBe('viewer_personal');
    expect(deriveScopeFromInstanceId('pdb_x')).toBe('platform_default');
  });

  it('no longer emits the stale per_model_install bucket for any live prefix (L-M2)', () => {
    // The per_model_install scope remains a valid enum value (historical rows
    // + rate-card key) but is no longer DERIVED for any current instance-id
    // prefix — the table it named is gone.
    for (const id of ['mbi_x', 'bki_x', 'bus_pub_x', 'bus_view_x', 'pdb_x']) {
      expect(deriveScopeFromInstanceId(id)).not.toBe('per_model_install');
    }
  });

  it('returns null for unknown prefixes (defensive — caller shouldn\'t attribute)', () => {
    expect(deriveScopeFromInstanceId('xx_01HZK')).toBeNull();
    expect(deriveScopeFromInstanceId('')).toBeNull();
    // A bus_ id without the pub_/view_ inner prefix is also rejected —
    // the substrate only emits bus_pub_ / bus_view_ in practice.
    expect(deriveScopeFromInstanceId('bus_01HZK')).toBeNull();
  });
});

describe('encodeAttributionMetadata / extractAttribution', () => {
  it('roundtrips a complete attribution', () => {
    const original = {
      appId: 'app_abc',
      appBlockId: 'apb_def',
      blockInstanceId: 'mbi_xyz',
      scope: 'per_model_install' as const,
      modelId: 12345,
    };
    const encoded = encodeAttributionMetadata(original);
    expect(encoded).not.toBeNull();
    expect(encoded?.[ATTRIBUTION_METADATA_KEYS.appId]).toBe('app_abc');
    expect(encoded?.[ATTRIBUTION_METADATA_KEYS.modelId]).toBe('12345');

    const decoded = extractAttribution(encoded ?? {});
    expect(decoded).toEqual(original);
  });

  it('omits modelId when not provided', () => {
    const encoded = encodeAttributionMetadata({
      appId: 'app_abc',
      appBlockId: 'apb_def',
      blockInstanceId: 'mbi_xyz',
      scope: 'viewer_personal',
    });
    expect(encoded?.[ATTRIBUTION_METADATA_KEYS.modelId]).toBeUndefined();
    const decoded = extractAttribution(encoded ?? {});
    expect(decoded?.modelId).toBeUndefined();
  });

  it('returns null for empty / non-block metadata (no attribution write)', () => {
    expect(extractAttribution(null)).toBeNull();
    expect(extractAttribution({})).toBeNull();
    expect(
      extractAttribution({
        type: 'buzzPurchase',
        buzzAmount: '1000',
        userId: '42',
      })
    ).toBeNull();
  });

  it('returns null when only some attribution keys are present (corrupt write)', () => {
    expect(
      extractAttribution({
        [ATTRIBUTION_METADATA_KEYS.appId]: 'app_abc',
        // missing appBlockId, blockInstanceId, scope
      })
    ).toBeNull();
  });

  it('returns null when scope is not in the enum', () => {
    expect(
      extractAttribution({
        [ATTRIBUTION_METADATA_KEYS.appId]: 'app_abc',
        [ATTRIBUTION_METADATA_KEYS.appBlockId]: 'apb_def',
        [ATTRIBUTION_METADATA_KEYS.blockInstanceId]: 'mbi_xyz',
        [ATTRIBUTION_METADATA_KEYS.scope]: 'something_invalid',
      })
    ).toBeNull();
  });

  it('returns null on null/undefined attribution input to encode', () => {
    expect(encodeAttributionMetadata(null)).toBeNull();
    expect(encodeAttributionMetadata(undefined)).toBeNull();
  });

  it('blockAttributionSchema rejects oversized fields', () => {
    expect(
      blockAttributionSchema.safeParse({
        appId: 'a'.repeat(65),
        appBlockId: 'apb_def',
        blockInstanceId: 'mbi_xyz',
        scope: 'per_model_install',
      }).success
    ).toBe(false);
  });
});
