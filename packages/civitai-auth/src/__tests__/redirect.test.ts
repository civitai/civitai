import { describe, it, expect } from 'vitest';
import { readReturnUrl, readSync, isSafeReturnTarget, buildPostLoginRedirect } from '../redirect';

const u = (qs: string) => new URL(`https://auth.civitai.com/login${qs}`);
const civitai = { isAllowedOrigin: (o: string) => o.includes('civitai') };
const ORIGIN = 'https://auth.civitai.com';

describe('readReturnUrl', () => {
  it('prefers returnUrl, falls back to callbackUrl then /', () => {
    expect(readReturnUrl(u('?returnUrl=/a'))).toBe('/a');
    expect(readReturnUrl(u('?callbackUrl=/b'))).toBe('/b');
    expect(readReturnUrl(u(''))).toBe('/');
  });
  it('collapses /login recursion to /', () => {
    expect(readReturnUrl(u('?returnUrl=/login/oauth'))).toBe('/');
  });
});

describe('readSync', () => {
  it('reads the sync-account marker', () => {
    expect(readSync(u('?sync-account=red'))).toBe('red');
    expect(readSync(u('?sync=green'))).toBeNull(); // the old `sync` alias is gone
    expect(readSync(u(''))).toBeNull();
  });
});

describe('isSafeReturnTarget', () => {
  it('allows same-origin paths, rejects protocol-relative', () => {
    expect(isSafeReturnTarget('/x', civitai)).toBe(true);
    expect(isSafeReturnTarget('//evil.com', civitai)).toBe(false);
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
  it('collapses an unsafe target to /', () => {
    expect(buildPostLoginRedirect('https://evil.com', null, ORIGIN, civitai)).toBe('/');
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
