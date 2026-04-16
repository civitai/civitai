import { describe, it, expect } from 'vitest';
import {
  extractCloudflareUuid,
  isValidCivitaiImageUrl,
} from '~/utils/article-helpers';

describe('isValidCivitaiImageUrl', () => {
  it('accepts a bare UUID', () => {
    expect(isValidCivitaiImageUrl('5cd97133-1989-41bd-bdd9-7145e1b5cad6')).toBe(true);
  });

  it('accepts image.civitai.com URLs', () => {
    expect(
      isValidCivitaiImageUrl(
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/5cd97133-1989-41bd-bdd9-7145e1b5cad6/original=true/img.jpeg'
      )
    ).toBe(true);
  });

  it('accepts civitai.com URLs', () => {
    expect(isValidCivitaiImageUrl('https://civitai.com/images/12345')).toBe(true);
  });

  it('accepts wasabisys.com URLs', () => {
    expect(isValidCivitaiImageUrl('https://bucket.wasabisys.com/key')).toBe(true);
  });

  it('accepts civitai-prod S3 URLs', () => {
    expect(
      isValidCivitaiImageUrl('https://civitai-prod.s3.amazonaws.com/some-key')
    ).toBe(true);
  });

  it('rejects external domains', () => {
    expect(isValidCivitaiImageUrl('https://evil.com/image.jpg')).toBe(false);
    expect(isValidCivitaiImageUrl('https://imgur.com/abc.png')).toBe(false);
  });

  it('rejects empty or invalid input', () => {
    expect(isValidCivitaiImageUrl('')).toBe(false);
    expect(isValidCivitaiImageUrl('not-a-url-or-uuid')).toBe(false);
  });
});

describe('extractCloudflareUuid', () => {
  const UUID = '5cd97133-1989-41bd-bdd9-7145e1b5cad6';

  it('returns a bare UUID as-is', () => {
    expect(extractCloudflareUuid(UUID)).toBe(UUID);
  });

  it('extracts UUID from standard Cloudflare image URL', () => {
    expect(
      extractCloudflareUuid(
        `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${UUID}/original=true/${UUID}.jpeg`
      )
    ).toBe(UUID);
  });

  it('extracts UUID from shorter Cloudflare URL paths', () => {
    expect(
      extractCloudflareUuid(`https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${UUID}`)
    ).toBe(UUID);
  });

  it('returns null for external URLs', () => {
    expect(extractCloudflareUuid('https://evil.com/image.jpg')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractCloudflareUuid('')).toBeNull();
  });

  it('returns null for non-UUID paths on valid domains', () => {
    expect(extractCloudflareUuid('https://civitai.com/models/12345')).toBeNull();
  });
});
