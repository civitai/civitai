import { describe, expect, it } from 'vitest';
import {
  assertNoOnPlatformSurface,
  MAX_EXTERNAL_URL_LENGTH,
  validateExternalUrl,
} from '~/server/schema/blocks/external-app.schema';

/**
 * App Blocks — off-site (external-link) app validation (PURE EXTERNAL LINK).
 *
 * Pins the two registration gates:
 *   (a) the external URL must be a well-formed https:// URL, and
 *   (b) external-link is MUTUALLY EXCLUSIVE with on-platform hosting (no page /
 *       iframe / target slot).
 * Plus the registration input schema shape.
 */

describe('validateExternalUrl', () => {
  it('accepts a well-formed https URL and returns the canonical form', () => {
    const r = validateExternalUrl('https://example.com/app');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://example.com/app');
  });

  it('accepts https with a path, query, and port', () => {
    const r = validateExternalUrl('https://sub.example.com:8443/path?x=1#frag');
    expect(r.ok).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    const r = validateExternalUrl('  https://example.com  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://example.com/');
  });

  it('REJECTS a non-https (http) URL', () => {
    const r = validateExternalUrl('http://example.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/https/i);
  });

  it('REJECTS dangerous schemes (javascript / data / mailto / ftp)', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'mailto:foo@bar.com',
      'ftp://example.com/file',
    ]) {
      const r = validateExternalUrl(url);
      expect(r.ok, `"${url}" must be rejected`).toBe(false);
    }
  });

  it('REJECTS a non-absolute / malformed URL', () => {
    for (const url of ['example.com', '/relative/path', 'not a url', 'https://']) {
      const r = validateExternalUrl(url);
      expect(r.ok, `"${url}" must be rejected`).toBe(false);
    }
  });

  it('REJECTS malformed https-prefixed values the loose `^https://` regex accepts (anchor-guard unification)', () => {
    // The mod/author anchors previously gated on a loose `^https://` regex while the
    // review checklist used this URL-parse guard. These values match the regex (so the
    // old anchor rendered them CLICKABLE) but have no parseable host (so the checklist
    // warned) — the exact disagreement. Both anchors now gate on `validateExternalUrl`,
    // so a malformed-but-https-prefixed value renders as INERT text everywhere.
    for (const url of ['https://', 'https:///', 'https://[bad', 'https://%', 'https:// nohost', 'https://a b']) {
      const r = validateExternalUrl(url);
      expect(r.ok, `"${url}" must be rejected (no parseable host)`).toBe(false);
    }
  });

  it('REJECTS a non-string / empty input', () => {
    expect(validateExternalUrl(undefined).ok).toBe(false);
    expect(validateExternalUrl(null).ok).toBe(false);
    expect(validateExternalUrl(123).ok).toBe(false);
    expect(validateExternalUrl('').ok).toBe(false);
    expect(validateExternalUrl('   ').ok).toBe(false);
  });

  it('REJECTS an over-long URL', () => {
    const long = 'https://example.com/' + 'a'.repeat(MAX_EXTERNAL_URL_LENGTH);
    expect(validateExternalUrl(long).ok).toBe(false);
  });

  it('REJECTS a URL with embedded credentials (userinfo phishing vector)', () => {
    // `https://example.com@evil.com` DISPLAYS as example.com but the real host is
    // evil.com — a display-vs-real-host phishing vector; reject it outright.
    for (const url of [
      'https://example.com@evil.com',
      'https://user:pass@evil.com',
      'https://user@example.com/app',
      'https://:pass@example.com',
    ]) {
      const r = validateExternalUrl(url);
      expect(r.ok, `"${url}" must be rejected`).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/credential/i);
    }
  });

  it('accepts a normal https URL that merely CONTAINS an @ in the path/query (not userinfo)', () => {
    const r = validateExternalUrl('https://example.com/u/@handle?to=a@b.com');
    expect(r.ok).toBe(true);
  });
});

describe('assertNoOnPlatformSurface (external ⟂ on-platform)', () => {
  it('accepts a display-only manifest (name + description only)', () => {
    expect(assertNoOnPlatformSurface({ name: 'Cool', description: 'desc' }).ok).toBe(true);
    expect(assertNoOnPlatformSurface({}).ok).toBe(true);
  });

  it('REJECTS a manifest declaring a page surface', () => {
    const r = assertNoOnPlatformSurface({ name: 'X', page: { path: '/run' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/page/i);
  });

  it('REJECTS a manifest declaring target slots', () => {
    const r = assertNoOnPlatformSurface({ name: 'X', targets: [{ slotId: 'model.sidebar_top' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/slot/i);
  });

  it('REJECTS a manifest declaring an iframe surface', () => {
    const r = assertNoOnPlatformSurface({ name: 'X', iframe: { src: 'https://x.civit.ai' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/iframe/i);
  });

  it('an EMPTY targets array is allowed (declares nothing)', () => {
    expect(assertNoOnPlatformSurface({ name: 'X', targets: [] }).ok).toBe(true);
  });
});
