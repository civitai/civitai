import { describe, expect, it } from 'vitest';
import {
  ImageIngestionUrlBlockedError,
  isAllowedAvatarUrl,
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
    // Name deliberately does NOT say "lacking the // separator" — the last row has one. What
    // every row shares is that getEdgeUrl forwards it unmodified while it is not a fetchable
    // http(s) URL on an allowed host.
  ])('rejects %s — forwarded unmodified by getEdgeUrl but not an allowed http(s) URL', (url) => {
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
  // One row per shape: packed into a single `it`, a regression reports "1 test red" naming
  // only the first, and cannot say whether the others are also open.
  it.each([
    ['file:///etc/passwd'],
    ['//evil.com/a.png'],
    ['ftp://evil.com/a.png'],
    ['data:text/html,<script>'],
  ])('rejects %s — a scheme or authority masquerading as a relative key', (url) => {
    expect(isAllowedImageScanUrl(url)).toBe(false);
  });

  /**
   * 🔴 Pins `SCHEME_PREFIX`'s `/i` INDEPENDENTLY of the blob rule.
   *
   * `isEdgeUrlPassthrough` is case-SENSITIVE, so an upper/mixed-case scheme is not
   * passthrough and lands on the relative-key branch where `SCHEME_PREFIX` is the only thing
   * standing. Dropping its `/i` therefore admits `Http:/127.0.0.1:6379/` — the exact shape
   * this module exists to reject, with one letter capitalised — and before these rows that
   * mutation passed the entire suite. The `BLOB:` row elsewhere could not catch it: the two
   * case-insensitive flags shadowed each other, so each looked covered while neither was.
   */
  it.each([
    ['Http:/127.0.0.1:6379/'],
    ['HTTP:/169.254.169.254/latest/'],
    ['FILE:///etc/passwd'],
    ['DATA:text/html,x'],
    ['FTP://evil.com/a'],
  ])('rejects %s — an upper-case scheme is still a scheme', (url) => {
    expect(isAllowedImageScanUrl(url)).toBe(false);
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
  it.each([
    [String.raw`https://image.civitai.com\@127.0.0.1:6379/x`],
    [String.raw`https://civitai.com\@169.254.169.254/latest/`],
    ['https://image.civitai.com@127.0.0.1:6379/x'],
    ['https://user:pw@image.civitai.com/a.png'],
  ])('rejects %s — a parser-ambiguous authority', (url) => {
    expect(isAllowedImageScanUrl(url)).toBe(false);
  });

  /**
   * Pins the C0/DEL half of `hasAmbiguousAuthority` on the ABSOLUTE branch, which the userinfo
   * check does NOT cover: WHATWG DELETES an interior tab, so `evil.com<TAB>.civitai.com` parses
   * to hostname `evil.com.civitai.com` — which `isValidCivitaiImageUrl`'s suffix rule ADMITS,
   * with an empty `username` — while an RFC-3986 client that does not strip tabs reads the
   * authority as `evil.com`. Measured; only the byte check refuses it.
   */
  it.each([
    [`https://evil.com${String.fromCharCode(9)}.civitai.com/a.png`],
    [`https://evil.com${String.fromCharCode(10)}.civitai.com/a.png`],
    [`https://evil.com${String.fromCharCode(13)}.civitai.com/a.png`],
  ])('rejects an interior control byte splicing an allowed host suffix (%#)', (url) => {
    expect(isAllowedImageScanUrl(url)).toBe(false);
  });

  /**
   * 🔴 Isolates the C0/DEL half of `hasAmbiguousAuthority`, which is load-bearing ONLY here.
   * `isAllowedImageScanUrl` refuses these at its own top-level byte check, so a row driven
   * through it cannot distinguish the wide predicate from the bare backslash test it replaced —
   * measured: narrowing `hasAmbiguousAuthority` passed the whole suite until this row existed.
   *
   * These are the dangerous shape because `verifyAvatar` STORES the raw argument: the tab is
   * deleted by WHATWG, so `href` lands exactly on an allowed prefix with an empty `username`,
   * and every other check passes — while the value persisted into `User.image` still carries the
   * control byte, which the module this check came from documents as a request-splitting /
   * log-injection primitive.
   */
  it.each([
    [`https://cdn.discord${String.fromCharCode(9)}app.com/avatars/1/a.png`],
    [`https://cdn.discordapp.com/ava${String.fromCharCode(9)}tars/1/a.png`],
    [`https://cdn.discordapp.com/avatars/1/a.png${String.fromCharCode(13)}`],
  ])(
    'isAllowedAvatarUrl rejects a control byte that normalizes onto an allowed prefix (%#)',
    (url) => {
      expect(isAllowedAvatarUrl(url)).toBe(false);
    }
  );

  /**
   * The prefix list's stated purpose is excluding `cdn.discordapp.com/attachments/…`,
   * which serves arbitrary user uploads. Tested against the RAW string it does not
   * deliver that: `…/avatars/../attachments/x` passes `startsWith` and resolves to
   * `/attachments/x`.
   */
  /**
   * The absolute branch refused a backslash from the start; the relative branch did not, and
   * these three carry no scheme and no leading `//`, so they were taken as relative keys.
   * A WHATWG parser given a base resolves all three to host `evil.com`.
   */
  it.each([['\\\\evil.com/x.png'], ['\\/evil.com/x.png'], ['/\\evil.com/x.png']])(
    'rejects %s — a backslash authority masquerading as a relative key',
    (url) => {
      expect(isAllowedImageScanUrl(url)).toBe(false);
    }
  );

  /**
   * A leading ASCII space is the one byte `hasUrlAmbiguousBytes` cannot see (0x20 sits above
   * the C0 range) and WHATWG strips it, so these are classified as relative keys while
   * resolving to a foreign host. Brute-forced: U+0020 is the only escaping code point.
   */
  it.each([[' http://evil.com/x.png'], [' //evil.com/x.png'], ['  https://evil.com/x.png']])(
    'rejects %j — a leading space smuggling an authority past the shape test',
    (url) => {
      expect(isAllowedImageScanUrl(url)).toBe(false);
    }
  );

  it('still allows an interior space, which real delivery filenames carry', () => {
    expect(isAllowedImageScanUrl('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/my file name.png')).toBe(
      true
    );
  });

  /**
   * Pins the `hasUrlAmbiguousBytes` widening ON THE RELATIVE BRANCH, where it is the only thing
   * standing.
   *
   * 🔴 The control byte must be INTERIOR. A LEADING one is already refused by the
   * leading-whitespace test above, so a prefixed row cannot distinguish the wide predicate from
   * the bare backslash check it replaced — measured: with prefixed rows only, reverting to
   * `raw.includes('\\')` passed the entire suite. WHATWG DELETES tab/LF/CR from anywhere in a
   * URL, so `htt<TAB>p://evil.com/x` is not `startsWith('http')`, matches no scheme, does not
   * start `//` — and resolves to host `evil.com`.
   */
  it.each([
    [`htt${String.fromCharCode(9)}p://evil.com/x.png`],
    [`htt${String.fromCharCode(10)}p://evil.com/x.png`],
    [`htt${String.fromCharCode(13)}ps://evil.com/x.png`],
    [`/${String.fromCharCode(9)}/evil.com/x.png`],
  ])('rejects an INTERIOR control byte reassembling an authority (%#)', (url) => {
    expect(isAllowedImageScanUrl(url)).toBe(false);
  });

  it('rejects an ENCODED separator inside an avatar path, in either case', () => {
    // WHATWG preserves the case of an existing percent-encoding in `pathname`, so an
    // upper-case %2F survives a lower-case-only test — and %5C is the backslash spelling.
    expect(
      isAllowedImageScanUrl('https://cdn.discordapp.com/avatars/..%2Fattachments/1/2/e.png')
    ).toBe(false);
    expect(
      isAllowedImageScanUrl('https://cdn.discordapp.com/avatars/..%5cattachments/1/2/e.png')
    ).toBe(false);
    expect(
      isAllowedImageScanUrl('https://cdn.discordapp.com/avatars/..%5Cattachments/1/2/e.png')
    ).toBe(false);
  });

  it('rejects an ENCODED separator inside an avatar path', () => {
    // `%2f` does not collapse during href normalization, so the prefix still matches while a
    // client that decodes it before resolving the path escapes into /attachments/.
    expect(
      isAllowedImageScanUrl('https://cdn.discordapp.com/avatars/..%2fattachments/1/2/e.png')
    ).toBe(false);
    expect(
      isAllowedImageScanUrl('https://cdn.discordapp.com/avatars/%2e%2e%2fattachments/e.png')
    ).toBe(false);
  });

  it.each([
    ['https://cdn.discordapp.com/avatars/../attachments/1/2/e.png'],
    ['https://cdn.discordapp.com/avatars/%2e%2e/attachments/1/2/e.png'],
    ['https://avatars.githubusercontent.com/u/../../x/y.png'],
  ])('rejects %s — traversal escaping an allowed avatar prefix', (url) => {
    expect(isAllowedImageScanUrl(url)).toBe(false);
  });

  /**
   * `verifyAvatar` (user.controller) consumes the SAME predicate, so the traversal that is
   * refused at ingestion must be refused there too. Before that consolidation the list was
   * shared while the test applying it was not, and these exact values were accepted on the
   * avatar path — with a comment on each side asserting the two could not drift.
   */
  it.each([
    ['https://cdn.discordapp.com/avatars/../attachments/1/2/e.png'],
    ['https://cdn.discordapp.com/avatars/..%2fattachments/1/2/e.png'],
    [String.raw`https://cdn.discordapp.com/avatars\@127.0.0.1/x.png`],
  ])('isAllowedAvatarUrl rejects %s', (url) => {
    expect(isAllowedAvatarUrl(url)).toBe(false);
  });

  it('isAllowedAvatarUrl allows the real avatar shapes', () => {
    expect(isAllowedAvatarUrl('https://cdn.discordapp.com/avatars/123/abc.png')).toBe(true);
    expect(isAllowedAvatarUrl('https://lh3.googleusercontent.com/a/AAcHTtf=s96-c')).toBe(true);
    // Not an avatar host at all, even though it is one of our storage hosts.
    expect(isAllowedAvatarUrl('https://image.civitai.com/x/y.png')).toBe(false);
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
