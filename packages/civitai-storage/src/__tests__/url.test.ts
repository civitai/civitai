import { describe, it, expect } from 'vitest';
import { parseKey, parseB2Url, isB2Url } from '../url';

const S3_HOST = 'account.r2.cloudflarestorage.com';
const B2_HOST = 's3.us-west-004.backblazeb2.com';

describe('parseKey', () => {
  it('returns a bare key for a non-URL string', () => {
    expect(parseKey('abc123def')).toEqual({ key: 'abc123def' });
  });

  it('parses path-style when the host matches s3Host (bucket in path)', () => {
    expect(
      parseKey(`https://${S3_HOST}/my-bucket/path/to/file.png`, { s3Host: S3_HOST })
    ).toEqual({ bucket: 'my-bucket', key: 'path/to/file.png' });
  });

  it('parses virtual-host style by stripping .s3Host from the hostname', () => {
    expect(
      parseKey(`https://my-bucket.${S3_HOST}/path/to/file.png`, { s3Host: S3_HOST })
    ).toEqual({ bucket: 'my-bucket', key: 'path/to/file.png' });
  });

  it('parses path-style when the host matches b2Host', () => {
    expect(
      parseKey(`https://${B2_HOST}/civitai-media/abc.png`, { s3Host: S3_HOST, b2Host: B2_HOST })
    ).toEqual({ bucket: 'civitai-media', key: 'abc.png' });
  });

  it('falls back to the whole hostname as bucket when no s3Host is given', () => {
    // Bare-call ergonomics are lossy: with no host to strip, the whole hostname is the "bucket".
    expect(parseKey('https://my-bucket.example.com/path/file.png')).toEqual({
      bucket: 'my-bucket.example.com',
      key: 'path/file.png',
    });
  });
});

describe('parseB2Url', () => {
  it('parses public path-style (s3.<region>.backblazeb2.com/<bucket>/<key>)', () => {
    expect(parseB2Url('https://s3.us-west-004.backblazeb2.com/civitai-media/a/b.png')).toEqual({
      bucket: 'civitai-media',
      key: 'a/b.png',
    });
  });

  it('parses public virtual-host style (<bucket>.s3.<region>.backblazeb2.com/<key>)', () => {
    expect(parseB2Url('https://civitai-media.s3.us-west-004.backblazeb2.com/a/b.png')).toEqual({
      bucket: 'civitai-media',
      key: 'a/b.png',
    });
  });

  it('parses a configured (non-public) b2Host as path-style', () => {
    expect(
      parseB2Url('https://b2-proxy.internal/civitai-media/a.png', { b2Host: 'b2-proxy.internal' })
    ).toEqual({ bucket: 'civitai-media', key: 'a.png' });
  });

  it('returns null for a non-B2 URL', () => {
    expect(parseB2Url('https://example.com/foo/bar')).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(parseB2Url('not a url')).toBeNull();
  });

  it('returns null for a path-style URL missing the key segment', () => {
    expect(parseB2Url('https://s3.us-west-004.backblazeb2.com/only-bucket')).toBeNull();
  });
});

describe('isB2Url', () => {
  it('is true for a public backblazeb2.com host', () => {
    expect(isB2Url('https://s3.us-west-004.backblazeb2.com/b/k')).toBe(true);
  });

  it('is true for a configured b2Host', () => {
    expect(isB2Url('https://b2-proxy.internal/b/k', 'b2-proxy.internal')).toBe(true);
  });

  it('is still true for a canonical B2 URL even when a custom b2Host is configured', () => {
    // Regression guard for the parseB2Url/isB2Url alignment: the predicates must agree.
    const url = 'https://s3.us-west-004.backblazeb2.com/b/k';
    expect(isB2Url(url, 'b2-proxy.internal')).toBe(true);
    expect(parseB2Url(url, { b2Host: 'b2-proxy.internal' })).not.toBeNull();
  });

  it('is false for a non-B2 URL', () => {
    expect(isB2Url('https://civitai.com/x')).toBe(false);
  });

  it('is false for an unparseable string', () => {
    expect(isB2Url('garbage')).toBe(false);
  });
});
