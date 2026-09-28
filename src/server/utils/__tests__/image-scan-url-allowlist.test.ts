import { describe, expect, it } from 'vitest';
import {
  ImageIngestionUrlBlockedError,
  isAllowedImageScanUrl,
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

  it('rejects a lookalike host that merely ends with an allowed host', () => {
    expect(isAllowedImageScanUrl('https://image.civitai.com.evil.com/a.png')).toBe(false);
    expect(isAllowedImageScanUrl('https://evil-image.civitai.com/a.png')).toBe(true); // subdomain of ours, fine
  });

  it('rejects blob: and empty urls — blob is never fetchable server-side', () => {
    expect(
      isAllowedImageScanUrl('blob:https://civitai.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    ).toBe(false);
    expect(isAllowedImageScanUrl('BLOB:https://civitai.com/x')).toBe(false);
    expect(isAllowedImageScanUrl('')).toBe(false);
  });

  it('rejects garbage that parses as neither relative nor absolute', () => {
    // Not http(s)/blob:, so treated as a relative key that resolves onto our edge —
    // but URL-parsing failures inside the storage-host branch must not throw.
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
  it('rejects scheme forms that getEdgeUrl forwards unmodified but that lack the // separator', () => {
    expect(isAllowedImageScanUrl('http:/127.0.0.1:6379/')).toBe(false);
    expect(isAllowedImageScanUrl('http:/169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isAllowedImageScanUrl('https:/evil.com/a.png')).toBe(false);
    expect(isAllowedImageScanUrl('http:evil.com/a.png')).toBe(false);
    expect(isAllowedImageScanUrl('http:\\\\evil.com/a.png')).toBe(false);
    // Starts with `http`, so forwarded unmodified, but is not an http(s) URL at all.
    expect(isAllowedImageScanUrl('httpx://evil.com/a.png')).toBe(false);
  });

  it('still allows our own hosts written with the same slash-light scheme forms', () => {
    // These normalize onto our storage edge, so forwarding them is harmless; the guard
    // must reject by HOST, not by rejecting every unusual scheme spelling.
    expect(isAllowedImageScanUrl('http:/image.civitai.com/a/b.png')).toBe(true);
  });

  it('keeps treating non-http(s) schemes as relative keys — getEdgeUrl prefixes them', () => {
    // `file:` / protocol-relative do NOT start with `http`, so getEdgeUrl prefixes them
    // with our image location and they can only ever 404 on our own edge.
    expect(isAllowedImageScanUrl('file:///etc/passwd')).toBe(true);
    expect(isAllowedImageScanUrl('//evil.com/a.png')).toBe(true);
  });

  it('mirrors getEdgeUrl passthrough exactly — one predicate, three consumers', () => {
    // Structural: the allowlist and both getEdgeUrl call sites must consume the SAME
    // predicate. If this drifts, the behavioural rows above stop covering the real seam.
    expect(isEdgeUrlPassthrough('http:/127.0.0.1:6379/')).toBe(true);
    expect(isEdgeUrlPassthrough('blob:https://civitai.com/x')).toBe(true);
    expect(isEdgeUrlPassthrough('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/name.png')).toBe(false);
    expect(isEdgeUrlPassthrough('file:///etc/passwd')).toBe(false);
  });

  it('names the rejected url in the error, never the callback', () => {
    const err = new ImageIngestionUrlBlockedError('https://evil.com/x.png');
    expect(err.message).toBe('Image url is not on the ingestion allowlist: https://evil.com/x.png');
    expect(err.name).toBe('ImageIngestionUrlBlockedError');
  });
});
