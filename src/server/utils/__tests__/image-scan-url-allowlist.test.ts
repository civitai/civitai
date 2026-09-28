import { describe, expect, it } from 'vitest';
import {
  ImageIngestionUrlBlockedError,
  isAllowedImageScanUrl,
  normalizeImageScanUrl,
} from '~/server/utils/image-scan-url';
import { isEdgeUrlPassthrough } from '~/shared/utils/edge-url-passthrough';

/**
 * The URL allowlist the image-scan ingestion submit enforces.
 *
 * The predicate is the security boundary — the funnel (`createImageIngestionRequest`)
 * and the seam (`ingestImage`) both consume it — so this matrix is pinned to literal
 * expected values rather than derived from the implementation: each row names a URL
 * shape with a known provenance (storage, avatar, attacker, client bug).
 */
describe('isAllowedImageScanUrl', () => {
  it('allows relative media keys — they resolve onto our storage edge', () => {
    expect(isAllowedImageScanUrl('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/name.png')).toBe(true);
    expect(isAllowedImageScanUrl('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
  });

  it('allows our storage hosts', () => {
    expect(
      isAllowedImageScanUrl(
        'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/original=true/name.jpeg'
      )
    ).toBe(true);
    expect(
      isAllowedImageScanUrl('https://images.civitai.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/x.png')
    ).toBe(true);
    expect(isAllowedImageScanUrl('https://civitai-prod.s3.amazonaws.com/some/key.png')).toBe(true);
    expect(isAllowedImageScanUrl('https://wasabisys.com/some/key.png')).toBe(true);
  });

  it('allows the OAuth avatar hosts — as path prefixes, not bare hosts', () => {
    expect(isAllowedImageScanUrl('https://cdn.discordapp.com/avatars/123/abc.png')).toBe(true);
    expect(isAllowedImageScanUrl('https://cdn.discordapp.com/embed/avatars/3.png')).toBe(true);
    expect(isAllowedImageScanUrl('https://avatars.githubusercontent.com/u/12345?v=4')).toBe(true);
    expect(isAllowedImageScanUrl('https://lh3.googleusercontent.com/a/AAcHTtf=s96-c')).toBe(true);
  });

  it('rejects arbitrary external hosts — the SSRF payload', () => {
    expect(isAllowedImageScanUrl('https://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(
      isAllowedImageScanUrl('http://internal-service.civitai.svc.cluster.local:9000/metrics')
    ).toBe(false);
    expect(isAllowedImageScanUrl('https://evil.com/image.png')).toBe(false);
  });

  it('rejects an off-avatar path on an otherwise-allowed avatar host', () => {
    // cdn.discordapp.com also serves arbitrary /attachments/ uploads — a bare-host
    // check would admit attacker-chosen content there.
    expect(isAllowedImageScanUrl('https://cdn.discordapp.com/attachments/123/abc.png')).toBe(false);
    expect(isAllowedImageScanUrl('https://cdn.discordapp.com/')).toBe(false);
    expect(isAllowedImageScanUrl('https://avatars.githubusercontent.com/evil/abc.png')).toBe(false);
  });

  it('rejects a lookalike host, but still allows a real subdomain of ours', () => {
    expect(isAllowedImageScanUrl('https://image.civitai.com.evil.com/a.png')).toBe(false);
    // Positive control: proves the row above fails on the SUFFIX rule, not because the
    // matcher rejects everything that merely looks unusual.
    expect(isAllowedImageScanUrl('https://evil-image.civitai.com/a.png')).toBe(true);
  });

  it('rejects blob: and empty urls — blob is never fetchable server-side', () => {
    expect(
      isAllowedImageScanUrl('blob:https://civitai.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    ).toBe(false);
    expect(isAllowedImageScanUrl('BLOB:https://civitai.com/x')).toBe(false);
    expect(isAllowedImageScanUrl('')).toBe(false);
    // Starts with `blob` but is not `blob:` — refused by the protocol test, which is why
    // no second `startsWith('blob')` branch is needed (it would be unreachable).
    expect(isAllowedImageScanUrl('blobx://image.civitai.com/a.png')).toBe(false);
    expect(isAllowedImageScanUrl('blob')).toBe(false);
  });

  it('rejects an unparseable url without throwing', () => {
    // `http://[` DOES start with `http`, so it is passthrough and reaches the host branch;
    // the point is that a `new URL()` failure there is caught and reported as "not allowed"
    // rather than propagating.
    expect(() => isAllowedImageScanUrl('http://[')).not.toThrow();
    expect(isAllowedImageScanUrl('http://[')).toBe(false);
  });

  /**
   * The allowlist is only a boundary if it gates EXACTLY the set `getEdgeUrl` forwards
   * unmodified. A URL that this predicate treats as a relative key but `getEdgeUrl`
   * passes straight through reaches the orchestrator verbatim — and WHATWG URL parsing
   * accepts a single slash after a special scheme, so `http:/host` is normalized back to
   * `http://host` at the fetch. These rows are that gap, pinned to literal `false`.
   */
  // `it.each`, not one packed `it`: these are the exact shapes the fix exists for, and in a
  // single test only the first is ever evaluated on the red path — so a regression could
  // only ever report "1 test red" and could not say which shapes are still covered.
  it.each([
    ['http:/127.0.0.1:6379/'],
    ['http:/169.254.169.254/latest/meta-data/'],
    ['https:/evil.com/a.png'],
    ['http:evil.com/a.png'],
    ['http:\\\\evil.com/a.png'],
    // Starts with `http`, so forwarded unmodified, but is not an http(s) URL at all.
    ['httpx://evil.com/a.png'],
  ])('rejects %s — forwarded unmodified by getEdgeUrl but lacking the // separator', (url) => {
    expect(isAllowedImageScanUrl(url)).toBe(false);
  });

  it('still allows our own hosts written with the same slash-light scheme forms', () => {
    // These normalize onto our storage edge, so forwarding them is harmless; the guard
    // must reject by HOST, not by rejecting every unusual scheme spelling.
    expect(isAllowedImageScanUrl('http:/image.civitai.com/a/b.png')).toBe(true);
  });

  /**
   * A string is only safe to treat as a relative CF key if it IS one. The old reasoning
   * — "getEdgeUrl prefixes it, so it can only land on our storage edge" — is
   * env-conditional: `NEXT_PUBLIC_IMAGE_LOCATION` is `z.string().default('')`
   * (src/env/client-schema.ts) and the prefix is dropped by `.filter(Boolean)`
   * (edge-url.ts), so with it empty a scheme- or authority-bearing string is emitted
   * essentially verbatim. Reject those on their shape instead of trusting the env.
   */
  it('rejects a scheme or an authority masquerading as a relative key', () => {
    expect(isAllowedImageScanUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedImageScanUrl('//evil.com/a.png')).toBe(false);
    expect(isAllowedImageScanUrl('ftp://evil.com/a.png')).toBe(false);
    expect(isAllowedImageScanUrl('data:text/html,<script>')).toBe(false);
  });

  it('still allows a real relative CF key, colons in the filename included', () => {
    expect(isAllowedImageScanUrl('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/my:file.png')).toBe(true);
    expect(isAllowedImageScanUrl('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/original=true/n.jpeg')).toBe(
      true
    );
  });

  /**
   * 🔴 The guard judges a host with WHATWG `new URL()`; the orchestrator fetches with an
   * RFC-3986 client. They disagree about where the authority ends when a `\` precedes an
   * `@`: WHATWG folds `\` to `/` (authority ends at it), RFC parsers read it as userinfo
   * (authority ends at the `@`). MEASURED on `https://image.civitai.com\@127.0.0.1:6379/x`
   * — Node reports hostname `image.civitai.com`, Python `urlsplit` reports `127.0.0.1:6379`,
   * and `curl` connects to 127.0.0.1. Explicit userinfo is the same hazard spelled openly.
   */
  it('rejects a parser-ambiguous authority — backslash or userinfo before the host', () => {
    expect(isAllowedImageScanUrl(String.raw`https://image.civitai.com\@127.0.0.1:6379/x`)).toBe(
      false
    );
    expect(isAllowedImageScanUrl(String.raw`https://civitai.com\@169.254.169.254/latest/`)).toBe(
      false
    );
    expect(isAllowedImageScanUrl('https://image.civitai.com@127.0.0.1:6379/x')).toBe(false);
    expect(isAllowedImageScanUrl('https://user:pw@image.civitai.com/a.png')).toBe(false);
  });

  /**
   * The prefix list's stated purpose is excluding `cdn.discordapp.com/attachments/…`,
   * which serves arbitrary user uploads. Tested against the RAW string it does not
   * deliver that: `…/avatars/../attachments/x` passes `startsWith` and resolves to
   * `/attachments/x`.
   */
  it('rejects path traversal that escapes an allowed avatar prefix', () => {
    expect(
      isAllowedImageScanUrl('https://cdn.discordapp.com/avatars/../attachments/1/2/e.png')
    ).toBe(false);
    expect(
      isAllowedImageScanUrl('https://cdn.discordapp.com/avatars/%2e%2e/attachments/1/2/e.png')
    ).toBe(false);
    expect(isAllowedImageScanUrl('https://avatars.githubusercontent.com/u/../../x/y.png')).toBe(
      false
    );
  });

  it('normalizes an absolute url so the guard and the fetcher cannot disagree', () => {
    // What gets handed onward is the parsed href, not the caller's spelling.
    expect(normalizeImageScanUrl('http:/image.civitai.com/a/b.png')).toBe(
      'http://image.civitai.com/a/b.png'
    );
    // A relative key is left alone for getEdgeUrl to prefix.
    expect(normalizeImageScanUrl('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/n.png')).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/n.png'
    );
  });

  it('mirrors getEdgeUrl passthrough exactly — one predicate, three consumers', () => {
    // Structural: the allowlist and both getEdgeUrl call sites must consume the SAME
    // predicate. If this drifts, the behavioural rows above stop covering the real seam.
    expect(isEdgeUrlPassthrough('http:/127.0.0.1:6379/')).toBe(true);
    expect(isEdgeUrlPassthrough('blob:https://civitai.com/x')).toBe(true);
    expect(isEdgeUrlPassthrough('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/name.png')).toBe(false);
    expect(isEdgeUrlPassthrough('file:///etc/passwd')).toBe(false);
  });

  it('names the rejected url in the error message', () => {
    const err = new ImageIngestionUrlBlockedError('https://evil.com/x.png');
    expect(err.message).toBe('Image url is not on the ingestion allowlist: https://evil.com/x.png');
    expect(err.name).toBe('ImageIngestionUrlBlockedError');
  });
});
