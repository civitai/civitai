import { describe, expect, it } from 'vitest';
import {
  CIVITAI_IMAGE_HOSTS,
  isAllowedSaveImageUrl,
  resolveSaveImageRequest,
  sanitizeDownloadFilename,
} from './saveImageDownload';

const CDN = 'https://image.civitai.com';

describe('isAllowedSaveImageUrl (SAVE_IMAGE origin allowlist)', () => {
  it('ALLOWS the civitai image CDN + orchestration blob hosts (https)', () => {
    expect(isAllowedSaveImageUrl('https://image.civitai.com/xG/77/original.jpeg', CDN)).toBe(true);
    expect(
      isAllowedSaveImageUrl(
        'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=x',
        CDN
      )
    ).toBe(true);
    // sanity: the static list is exactly the two known product hosts
    expect([...CIVITAI_IMAGE_HOSTS].sort()).toEqual(['image.civitai.com', 'orchestration.civitai.com']);
  });

  it('ALLOWS the configured CDN origin even when not in the static list', () => {
    // A self-hosted / non-prod NEXT_PUBLIC_IMAGE_LOCATION is covered without editing the list.
    expect(isAllowedSaveImageUrl('https://cdn.example.net/a/b.jpeg', 'https://cdn.example.net')).toBe(true);
    // …but only that exact host — a different host is still refused.
    expect(isAllowedSaveImageUrl('https://other.example.net/a.jpeg', 'https://cdn.example.net')).toBe(false);
  });

  it('REJECTS an arbitrary attacker origin', () => {
    expect(isAllowedSaveImageUrl('https://evil.example/x.png', CDN)).toBe(false);
    expect(isAllowedSaveImageUrl('https://image.civitai.com.evil.example/x.png', CDN)).toBe(false);
    // no subdomain wildcarding
    expect(isAllowedSaveImageUrl('https://sub.image.civitai.com/x.png', CDN)).toBe(false);
  });

  it('REJECTS non-https schemes: data:, blob:, file:, http:', () => {
    expect(isAllowedSaveImageUrl('data:image/png;base64,AAAA', CDN)).toBe(false);
    expect(isAllowedSaveImageUrl('blob:https://image.civitai.com/uuid', CDN)).toBe(false);
    expect(isAllowedSaveImageUrl('file:///etc/passwd', CDN)).toBe(false);
    // plain http (downgrade/MITM) is refused even for an allowlisted host
    expect(isAllowedSaveImageUrl('http://image.civitai.com/x.png', CDN)).toBe(false);
  });

  it('REJECTS non-string / empty / unparseable input', () => {
    expect(isAllowedSaveImageUrl(undefined, CDN)).toBe(false);
    expect(isAllowedSaveImageUrl('', CDN)).toBe(false);
    expect(isAllowedSaveImageUrl('not a url', CDN)).toBe(false);
    expect(isAllowedSaveImageUrl(42, CDN)).toBe(false);
  });

  it('tolerates an empty / relative NEXT_PUBLIC_IMAGE_LOCATION (falls back to the static list)', () => {
    expect(isAllowedSaveImageUrl('https://image.civitai.com/x.png', '')).toBe(true);
    expect(isAllowedSaveImageUrl('https://evil.example/x.png', '')).toBe(false);
    expect(isAllowedSaveImageUrl('https://image.civitai.com/x.png', '/relative')).toBe(true);
  });
});

describe('sanitizeDownloadFilename', () => {
  it('strips query params and fragments', () => {
    expect(sanitizeDownloadFilename('a.jpeg?token=x#frag', 'https://x/y')).toBe('a.jpeg');
  });

  it('collapses a duplicated trailing extension, preserving base dots', () => {
    expect(sanitizeDownloadFilename('file.mp4.mp4', 'https://x/y')).toBe('file.mp4');
    expect(sanitizeDownloadFilename('video-ttget.com.mp4', 'https://x/y')).toBe('video-ttget.com.mp4');
  });

  it('drops path separators / traversal (untrusted block-supplied name)', () => {
    expect(sanitizeDownloadFilename('../../etc/passwd', 'https://x/y')).toBe('passwd');
    expect(sanitizeDownloadFilename('a/b/c.png', 'https://x/y')).toBe('c.png');
    expect(sanitizeDownloadFilename('..\\..\\win.png', 'https://x/y')).toBe('win.png');
  });

  it('falls back to the url last segment, then a generic name', () => {
    expect(sanitizeDownloadFilename(undefined, 'https://image.civitai.com/xG/77/original.jpeg')).toBe(
      'original.jpeg'
    );
    expect(sanitizeDownloadFilename(null, 'https://image.civitai.com/')).toBe('download');
    expect(sanitizeDownloadFilename('   ', 'https://image.civitai.com/')).toBe('download');
  });
});

describe('resolveSaveImageRequest', () => {
  it('parses a url-variant request', () => {
    expect(
      resolveSaveImageRequest({ requestId: 'r', url: 'https://image.civitai.com/x.jpeg', filename: 'a.png' })
    ).toEqual({ requestId: 'r', kind: 'url', url: 'https://image.civitai.com/x.jpeg', filename: 'a.png' });
  });

  it('parses an id-variant request', () => {
    expect(resolveSaveImageRequest({ requestId: 'r', imageId: 55 })).toEqual({
      requestId: 'r',
      kind: 'id',
      imageId: 55,
      filename: undefined,
    });
  });

  it('returns kind:invalid when BOTH url and imageId are present', () => {
    expect(
      resolveSaveImageRequest({ requestId: 'r', url: 'https://image.civitai.com/x.jpeg', imageId: 5 })
    ).toEqual({ requestId: 'r', kind: 'invalid' });
  });

  it('returns kind:invalid when NEITHER url nor imageId is present', () => {
    expect(resolveSaveImageRequest({ requestId: 'r' })).toEqual({ requestId: 'r', kind: 'invalid' });
  });

  it('rejects a non-positive / non-integer imageId (treated as absent → invalid)', () => {
    expect(resolveSaveImageRequest({ requestId: 'r', imageId: 0 })).toEqual({ requestId: 'r', kind: 'invalid' });
    expect(resolveSaveImageRequest({ requestId: 'r', imageId: -3 })).toEqual({ requestId: 'r', kind: 'invalid' });
    expect(resolveSaveImageRequest({ requestId: 'r', imageId: 1.5 })).toEqual({ requestId: 'r', kind: 'invalid' });
  });

  it('returns null (drop, uncorrelatable) for a missing/invalid requestId', () => {
    expect(resolveSaveImageRequest({ url: 'https://image.civitai.com/x.jpeg' })).toBeNull();
    expect(resolveSaveImageRequest({ requestId: '', url: 'https://image.civitai.com/x.jpeg' })).toBeNull();
    expect(resolveSaveImageRequest(null)).toBeNull();
    expect(resolveSaveImageRequest('nope')).toBeNull();
  });
});
