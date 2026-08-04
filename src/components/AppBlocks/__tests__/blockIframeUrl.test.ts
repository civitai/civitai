import { describe, expect, it } from 'vitest';

import { buildBlockIframeSrc, encodeBlockInitFragment } from '../blockIframeUrl';

/**
 * 🔴 THE LITERAL BELOW IS THE WIRE CONTRACT, and this test is the ONLY thing
 * holding the two repos together.
 *
 * civitai cannot import the SDK's decoder — it consumes the PUBLISHED
 * `@civitai/app-sdk` dist and the decoder ships in a version that is not
 * published when this lands — so `blockIframeUrl.ts` carries a mirrored
 * encoder. `civitai-app-starters`'
 * `packages/civitai-app-sdk/test/initFragment.test.ts` pins this SAME string
 * from the decoder's side. Change one and you must change the other.
 *
 * Deliberately a literal, NOT `encodeBlockInitFragment(...)` compared against
 * itself: an expectation derived from the implementation cannot detect a
 * format change, which is the exact failure this pin exists to catch.
 */
const WIRE_LITERAL = 'civitai-block=v1&theme=dark&renderMode=iframe&blockInstanceId=bi_abc';

describe('encodeBlockInitFragment', () => {
  it('produces the exact pinned wire literal', () => {
    expect(
      encodeBlockInitFragment({ theme: 'dark', renderMode: 'iframe', blockInstanceId: 'bi_abc' })
    ).toBe(WIRE_LITERAL);
  });

  it('percent-encodes a blockInstanceId so it cannot smuggle extra fragment keys', () => {
    const encoded = encodeBlockInitFragment({
      theme: 'light',
      renderMode: 'iframe',
      blockInstanceId: 'x&theme=dark',
    });
    expect(encoded).toBe(
      'civitai-block=v1&theme=light&renderMode=iframe&blockInstanceId=x%26theme%3Ddark'
    );
  });
});

describe('buildBlockIframeSrc', () => {
  const FIELDS = { theme: 'dark', renderMode: 'iframe', blockInstanceId: 'bi_abc' } as const;

  it('appends the fragment to a plain publisher src', () => {
    expect(buildBlockIframeSrc('https://demo.civit.ai/', FIELDS)).toBe(
      `https://demo.civit.ai/#${WIRE_LITERAL}`
    );
  });

  it('leaves an existing query string intact and does not touch it', () => {
    // The dev-tunnel route ships `?dev=<token>`; the fragment must be additive
    // and must not disturb the query.
    expect(buildBlockIframeSrc('https://tunnel.example.com/?dev=abc123', FIELDS)).toBe(
      `https://tunnel.example.com/?dev=abc123#${WIRE_LITERAL}`
    );
  });

  it('NO-STOMP: returns the src UNCHANGED when the publisher already uses the fragment', () => {
    // 🔴 The compatibility guard for hash-routing block apps. A publisher whose
    // src carries a fragment is the one population an appended fragment could
    // break, so they keep today's URL exactly and simply forgo the fast path.
    const hashRouted = 'https://demo.civit.ai/#/dashboard';
    expect(buildBlockIframeSrc(hashRouted, FIELDS)).toBe(hashRouted);

    const anchored = 'https://demo.civit.ai/page#section-2';
    expect(buildBlockIframeSrc(anchored, FIELDS)).toBe(anchored);
  });

  it('claims a BARE trailing hash (it carries no publisher state)', () => {
    expect(buildBlockIframeSrc('https://demo.civit.ai/#', FIELDS)).toBe(
      `https://demo.civit.ai/#${WIRE_LITERAL}`
    );
  });

  it('returns an empty src unchanged (malformed manifest — the host collapses on it)', () => {
    expect(buildBlockIframeSrc('', FIELDS)).toBe('');
  });

  it('returns an unparseable src unchanged rather than throwing', () => {
    expect(buildBlockIframeSrc('not a url', FIELDS)).toBe('not a url');
    expect(buildBlockIframeSrc('/relative/path', FIELDS)).toBe('/relative/path');
  });

  it('returns the src unchanged when there is no blockInstanceId to state', () => {
    expect(buildBlockIframeSrc('https://demo.civit.ai/', { ...FIELDS, blockInstanceId: '' })).toBe(
      'https://demo.civit.ai/'
    );
  });

  it('🔴 never puts a token, viewer or context in the URL', () => {
    // Belt on the security property: the ONLY three fields this function can
    // emit are the ones it takes. If a future edit widens the input, this
    // enumeration of the produced fragment keys fails.
    const out = buildBlockIframeSrc('https://demo.civit.ai/', FIELDS);
    const keys = [...new URLSearchParams(new URL(out).hash.slice(1)).keys()].sort();
    expect(keys).toEqual(['blockInstanceId', 'civitai-block', 'renderMode', 'theme']);
  });

  it('preserves the origin, so the postMessage target is unaffected', () => {
    const out = buildBlockIframeSrc('https://demo.civit.ai/app', FIELDS);
    expect(new URL(out).origin).toBe(new URL('https://demo.civit.ai/app').origin);
  });
});
