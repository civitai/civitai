import { describe, expect, it } from 'vitest';

import { isSameOriginBeacon } from '~/server/utils/beacon-same-origin';

/**
 * The same-origin beacon predicate, in isolation.
 *
 * What this suite CANNOT see is whether any endpoint calls it — a correct predicate nobody invokes
 * is green here and absent in production. That seam is pinned in
 * `src/__tests__/pages/api/application-error.test.ts`.
 *
 * 🔴 Read the accept cases as the load-bearing half. This predicate stands in front of a signal,
 * and a false REJECT deletes that signal silently, so each accept case below is a real request
 * shape rather than a convenience: the relative-fetch shape every in-app beacon produces, the
 * Origin-suppressed fallback, a non-default port, and a host the predicate has never been told
 * about.
 */

const req = (headers: { origin?: string; referer?: string; host?: string }) => ({ headers });

describe('isSameOriginBeacon — accepts what our own pages send', () => {
  it('accepts an Origin whose host equals the Host header', () => {
    expect(
      isSameOriginBeacon(req({ origin: 'https://civitai.example', host: 'civitai.example' }))
    ).toBe(true);
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(
      isSameOriginBeacon(
        req({ referer: 'https://civitai.example/models/1', host: 'civitai.example' })
      )
    ).toBe(true);
  });

  it('keeps a non-default port on BOTH sides, so it matches rather than rejecting', () => {
    // `new URL(...).host` includes the port and so does `Host`. Comparing `hostname` to `host`
    // instead would reject every deployment not on 443 — local and preview included.
    expect(
      isSameOriginBeacon(
        req({ origin: 'https://civitai.example:8443', host: 'civitai.example:8443' })
      )
    ).toBe(true);
  });

  it('ENUMERATES NO DOMAIN: an arbitrary, never-configured host is accepted on its own terms', () => {
    // 🔴 The property that makes this guard safe across a domain FAMILY. It compares the request
    // against ITSELF, so adding, renaming or previewing a served host cannot make reports from it
    // start failing. A guard built on a domain allowlist would need this test to enumerate the
    // list, and would silently drop whatever the list forgot.
    for (const host of [
      'civitai.example',
      'www.civitai.example',
      'other-colour.example',
      'pr-1234.preview.example',
      'internal.civitai.example',
      'xn--tst-6la.example',
    ]) {
      expect(isSameOriginBeacon(req({ origin: `https://${host}`, host }))).toBe(true);
    }
  });

  it('ignores the path, query and fragment of a Referer — only the host is compared', () => {
    expect(
      isSameOriginBeacon(
        req({ referer: 'https://civitai.example/a/b?c=d#e', host: 'civitai.example' })
      )
    ).toBe(true);
  });
});

describe('isSameOriginBeacon — rejects what our own pages cannot send', () => {
  it('rejects a cross-origin Origin', () => {
    expect(
      isSameOriginBeacon(req({ origin: 'https://attacker.example', host: 'civitai.example' }))
    ).toBe(false);
  });

  it('rejects a subdomain of the served host, which is a DIFFERENT origin', () => {
    expect(
      isSameOriginBeacon(req({ origin: 'https://evil.civitai.example', host: 'civitai.example' }))
    ).toBe(false);
  });

  it('rejects a host that merely has the served host as a SUFFIX', () => {
    // The classic substring bug. `evil-civitai.example` ends with `civitai.example` under a
    // `endsWith` comparison and is a wholly unrelated origin.
    expect(
      isSameOriginBeacon(req({ origin: 'https://evil-civitai.example', host: 'civitai.example' }))
    ).toBe(false);
  });

  it('rejects when Origin is present and mismatched even if Referer matches', () => {
    expect(
      isSameOriginBeacon(
        req({
          origin: 'https://attacker.example',
          referer: 'https://civitai.example/x',
          host: 'civitai.example',
        })
      )
    ).toBe(false);
  });

  it('🔴 rejects when NEITHER header is present — absent is not allowed', () => {
    // This is where the predicate gets its strength: an allow-on-absent rule is satisfied by
    // sending nothing at all. Pinned so a later edit cannot make the guard inert while looking
    // like it tightened it.
    expect(isSameOriginBeacon(req({ host: 'civitai.example' }))).toBe(false);
  });

  it('rejects rather than throwing on a malformed Origin', () => {
    for (const origin of ['', 'not a url', '://', 'https://', '%%%']) {
      expect(() => isSameOriginBeacon(req({ origin, host: 'civitai.example' }))).not.toThrow();
      expect(isSameOriginBeacon(req({ origin, host: 'civitai.example' }))).toBe(false);
    }
  });

  it('rejects when the Host header itself is absent', () => {
    // Both sides would be undefined-ish; a comparison that let that through would accept every
    // request that arrived without a Host.
    expect(isSameOriginBeacon(req({ origin: 'https://civitai.example' }))).toBe(false);
  });

  it('NEGATIVE CONTROL: the predicate is capable of returning BOTH values', () => {
    // Without this, a suite of `toBe(false)` assertions is indistinguishable from a predicate
    // hardwired to false — and a suite of `toBe(true)` from one hardwired to true.
    const results = new Set([
      isSameOriginBeacon(req({ origin: 'https://a.example', host: 'a.example' })),
      isSameOriginBeacon(req({ origin: 'https://a.example', host: 'b.example' })),
    ]);
    expect([...results].sort()).toEqual([false, true]);
  });
});
