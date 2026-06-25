import { describe, it, expect } from 'vitest';
import {
  readReturnUrl,
  readSync,
  isSafeReturnTarget,
  isCivitaiOrigin,
  buildPostLoginRedirect,
} from '../redirect';

const u = (qs: string) => new URL(`https://auth.civitai.com/login${qs}`);
const civitai = { isAllowedOrigin: (o: string) => o.includes('civitai') };
const ORIGIN = 'https://auth.civitai.com';

describe('readReturnUrl', () => {
  it('prefers returnUrl, falls back to callbackUrl then /', () => {
    expect(readReturnUrl(u('?returnUrl=/a'))).toBe('/a');
    expect(readReturnUrl(u('?callbackUrl=/b'))).toBe('/b');
    expect(readReturnUrl(u(''))).toBe('/');
  });
  it('collapses only the bare /login form, blocking the form recursion loop', () => {
    expect(readReturnUrl(u('?returnUrl=/login'))).toBe('/');
    expect(readReturnUrl(u('?returnUrl=/login?foo=1'))).toBe('/');
  });
  it('preserves the /login/oauth interaction pages (device + authorize)', () => {
    expect(readReturnUrl(u('?returnUrl=/login/oauth/device?code=ABCD-1234'))).toBe(
      '/login/oauth/device?code=ABCD-1234'
    );
    expect(readReturnUrl(u('?returnUrl=/login/oauth/authorize?client_id=x'))).toBe(
      '/login/oauth/authorize?client_id=x'
    );
  });
});

describe('readSync', () => {
  it('reads the sync-account marker', () => {
    expect(readSync(u('?sync-account=red'))).toBe('red');
    expect(readSync(u('?sync=green'))).toBeNull(); // the old `sync` alias is gone
    expect(readSync(u(''))).toBeNull();
  });
});

describe('isCivitaiOrigin', () => {
  it('allows owned eTLD+1s and their subdomains', () => {
    expect(isCivitaiOrigin('https://civitai.com')).toBe(true);
    expect(isCivitaiOrigin('https://civitai.red')).toBe(true);
    expect(isCivitaiOrigin('https://pr-2468.civitaic.com')).toBe(true); // preview host
    expect(isCivitaiOrigin('https://moderator.civitai.com')).toBe(true);
  });
  it('rejects the B1 open-redirect look-alikes (substring test would accept these)', () => {
    expect(isCivitaiOrigin('https://civitai.evil.com')).toBe(false);
    expect(isCivitaiOrigin('https://evil-civitai.com')).toBe(false);
    expect(isCivitaiOrigin('https://civitai.com.attacker.io')).toBe(false);
    expect(isCivitaiOrigin('https://xcivitai.com')).toBe(false);
    expect(isCivitaiOrigin('https://notcivitai.red')).toBe(false);
  });
  it('returns false for an unparseable origin', () => {
    expect(isCivitaiOrigin('not a url')).toBe(false);
  });
});

describe('isSafeReturnTarget', () => {
  it('allows same-origin paths, rejects protocol-relative + backslash-prefixed', () => {
    expect(isSafeReturnTarget('/x', civitai)).toBe(true);
    expect(isSafeReturnTarget('//evil.com', civitai)).toBe(false);
    expect(isSafeReturnTarget('/\\evil.com', civitai)).toBe(false); // `\`→`/` normalization
  });
  it('allows civitai origins, rejects others', () => {
    expect(isSafeReturnTarget('https://civitai.red/x', civitai)).toBe(true);
    expect(isSafeReturnTarget('https://evil.com/x', civitai)).toBe(false);
  });
  it('allowAllOrigins bypasses the check', () => {
    expect(isSafeReturnTarget('https://evil.com', { allowAllOrigins: true })).toBe(true);
  });
});

describe('buildPostLoginRedirect', () => {
  it('returns a validated target unchanged without sync', () => {
    expect(buildPostLoginRedirect('/dash', null, ORIGIN, civitai)).toBe('/dash');
  });
  it('collapses an unsafe target to / (open-redirect guard unchanged by the recursion-guard fix)', () => {
    // Narrowing readReturnUrl's /login recursion guard must NOT widen the open-redirect surface:
    // absolute external + protocol-relative targets still collapse to '/' here.
    expect(buildPostLoginRedirect('https://evil.com', null, ORIGIN, civitai)).toBe('/');
    expect(buildPostLoginRedirect('//evil.com', null, ORIGIN, civitai)).toBe('/');
  });
  it('re-attaches sync as sync-account on a relative target', () => {
    expect(buildPostLoginRedirect('/dash', 'green', ORIGIN, civitai)).toBe(
      '/dash?sync-account=green'
    );
  });
  it('re-attaches sync on an absolute civitai target', () => {
    expect(buildPostLoginRedirect('https://civitai.red/x', 'green', ORIGIN, civitai)).toBe(
      'https://civitai.red/x?sync-account=green'
    );
  });
  it('does not duplicate an existing sync-account', () => {
    expect(buildPostLoginRedirect('/dash?sync-account=red', 'green', ORIGIN, civitai)).toBe(
      '/dash?sync-account=red'
    );
  });
});
