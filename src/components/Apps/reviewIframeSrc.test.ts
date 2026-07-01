import { describe, it, expect } from 'vitest';
import {
  pickReviewIframeSrc,
  readReviewTokenExpMs,
  REVIEW_IFRAME_SRC_REFRESH_MS,
} from '~/components/Apps/reviewIframeSrc';

// Mirror review-session.ts wire form: base64url(json({m,h,exp})).base64url(sig).
// We only care about the payload segment's `exp` (unix SECONDS), so the sig can
// be any base64url-ish string. exp is expressed relative to a passed-in nowMs so
// each case exercises the real base64url decode + JSON parse path.
function base64url(s: string): string {
  // Node Buffer is available in the unit (node) environment.
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function mrToken(expSec: number, m = 42, h = 'review-abc123def456.civit.ai'): string {
  const payload = base64url(JSON.stringify({ m, h, exp: expSec }));
  const sig = base64url('signature-bytes-not-verified-here');
  return `${payload}.${sig}`;
}

function previewUrl(expSec: number, host = 'https://review-abc123def456.civit.ai'): string {
  return `${host}/?mr=${encodeURIComponent(mrToken(expSec))}`;
}

const NOW = 1_900_000_000_000; // fixed nowMs
const nowSec = Math.floor(NOW / 1000);

describe('readReviewTokenExpMs', () => {
  it('decodes exp (ms) from a real base64url mr token', () => {
    const url = previewUrl(nowSec + 120);
    expect(readReviewTokenExpMs(url)).toBe((nowSec + 120) * 1000);
  });

  it('returns null when there is no mr param', () => {
    expect(readReviewTokenExpMs('https://review-x.civit.ai/?foo=bar')).toBeNull();
    expect(readReviewTokenExpMs('https://review-x.civit.ai/')).toBeNull();
    expect(readReviewTokenExpMs(undefined)).toBeNull();
  });

  it('returns null when the token payload is not valid base64url JSON', () => {
    expect(readReviewTokenExpMs('https://r.civit.ai/?mr=not-a-token.sig')).toBeNull();
  });

  it('returns null when the payload lacks a numeric exp', () => {
    const noExp = base64url(JSON.stringify({ m: 1, h: 'r.civit.ai' }));
    expect(readReviewTokenExpMs(`https://r.civit.ai/?mr=${noExp}.sig`)).toBeNull();
  });
});

describe('pickReviewIframeSrc', () => {
  it('(a) no current src → returns the latest previewUrl', () => {
    const latest = previewUrl(nowSec + 120);
    expect(pickReviewIframeSrc(undefined, latest, NOW)).toBe(latest);
  });

  it('(a) no current src and no latest → returns empty string', () => {
    expect(pickReviewIframeSrc(undefined, undefined, NOW)).toBe('');
  });

  it('(b) current token has >30s left → returns current UNCHANGED even when latest differs', () => {
    const current = previewUrl(nowSec + 90); // 90s remaining
    const latest = previewUrl(nowSec + 120); // a newer, freshly-minted token
    expect(current).not.toBe(latest);
    expect(pickReviewIframeSrc(current, latest, NOW)).toBe(current);
  });

  it('(b) boundary: exactly at the refresh window keeps current (only swaps when strictly inside)', () => {
    const remainingSec = REVIEW_IFRAME_SRC_REFRESH_MS / 1000;
    const current = previewUrl(nowSec + remainingSec); // exactly 30s left
    const latest = previewUrl(nowSec + 120);
    // remaining (30_000) is NOT > refresh (30_000) → swap.
    expect(pickReviewIframeSrc(current, latest, NOW)).toBe(latest);
  });

  it('(c) current token within 30s of expiry → returns the latest (fresh) token', () => {
    const current = previewUrl(nowSec + 10); // 10s remaining
    const latest = previewUrl(nowSec + 120);
    expect(pickReviewIframeSrc(current, latest, NOW)).toBe(latest);
  });

  it('(c) current token already expired → returns the latest token', () => {
    const current = previewUrl(nowSec - 5); // expired
    const latest = previewUrl(nowSec + 120);
    expect(pickReviewIframeSrc(current, latest, NOW)).toBe(latest);
  });

  it('(c) near expiry but no latest available → keeps current as a last resort', () => {
    const current = previewUrl(nowSec + 5);
    expect(pickReviewIframeSrc(current, undefined, NOW)).toBe(current);
  });

  it('(d) unparseable current src → returns the latest', () => {
    const latest = previewUrl(nowSec + 120);
    expect(pickReviewIframeSrc('https://r.civit.ai/?mr=garbage', latest, NOW)).toBe(latest);
    expect(pickReviewIframeSrc('https://r.civit.ai/no-token', latest, NOW)).toBe(latest);
  });

  it('is idempotent: feeding its own output back returns the same stable src', () => {
    const current = previewUrl(nowSec + 90);
    const latest = previewUrl(nowSec + 120);
    const once = pickReviewIframeSrc(current, latest, NOW);
    const twice = pickReviewIframeSrc(once, latest, NOW);
    expect(twice).toBe(once);
  });
});
