import { describe, expect, it } from 'vitest';
import {
  buildTensorMetadataUrl,
  TENSOR_METADATA_CACHE_VERSION,
} from '~/utils/model-tensor-metadata';

/**
 * CU 868khnkuc: ~200K 422s are already sitting in the Cloudflare edge under `immutable` and do not
 * expire for a year. Shipping the header fix alone leaves every one of those files broken, so the
 * request carries a cache-key version the poisoned entries were never stored under. Bump it if we
 * ever poison the edge again.
 */
describe('buildTensorMetadataUrl', () => {
  it('carries the cache version on the summary request', () => {
    const url = buildTensorMetadataUrl(3057178, { summaryOnly: true });

    expect(url).toContain('/api/v1/model-files/3057178/tensor-metadata?');
    expect(new URL(url, 'https://civitai.com').searchParams.get('summaryOnly')).toBe('true');
    expect(new URL(url, 'https://civitai.com').searchParams.get('v')).toBe(
      String(TENSOR_METADATA_CACHE_VERSION)
    );
  });

  it('carries the cache version on the full request', () => {
    const url = buildTensorMetadataUrl(3057178);
    const params = new URL(url, 'https://civitai.com').searchParams;

    expect(params.get('summaryOnly')).toBeNull();
    expect(params.get('v')).toBe(String(TENSOR_METADATA_CACHE_VERSION));
  });

  it('is past the version the poisoned entries were cached under', () => {
    expect(TENSOR_METADATA_CACHE_VERSION).toBeGreaterThan(1);
  });
});
