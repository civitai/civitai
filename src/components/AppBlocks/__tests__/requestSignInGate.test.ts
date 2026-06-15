import { describe, expect, it } from 'vitest';
import { isSafeReturnUrl, resolveRequestSignIn } from '../requestSignInGate';

/**
 * Anonymous-conversion (REQUEST_SIGN_IN) — the host's handler must:
 *   (1) only start the login flow once BLOCK_READY has landed (status==='ready'),
 *       so a pre-handshake block can't pop a login modal before any interaction;
 *   (2) only honor a block-supplied returnUrl when it is a same-origin in-app
 *       path, never an absolute / protocol-relative URL (open-redirect guard).
 *
 * resolveRequestSignIn is the pure gate the handler delegates to. Origin +
 * event.source pinning is enforced upstream by usePostMessage (shared by every
 * inbound handler and covered by usePostMessage.test.ts) — these tests pin the
 * readiness gate and the returnUrl sanitisation, mirroring resolveBuzzPurchaseRequest.
 */
describe('resolveRequestSignIn (REQUEST_SIGN_IN gate)', () => {
  it('before BLOCK_READY → ignored (returns null), no login flow', () => {
    expect(resolveRequestSignIn('loading', {})).toBeNull();
    expect(resolveRequestSignIn('loading', { returnUrl: '/models/1' })).toBeNull();
  });

  it('does not honor the request during timeout / fatal / no_token fallbacks', () => {
    expect(resolveRequestSignIn('timeout', {})).toBeNull();
    expect(resolveRequestSignIn('fatal', {})).toBeNull();
    expect(resolveRequestSignIn('no_token', {})).toBeNull();
  });

  it('after BLOCK_READY (status=ready) with no returnUrl → opens, defaults to current page', () => {
    // {} (no returnUrl) tells the handler to let LoginModal default returnUrl
    // to router.asPath (the current page URL).
    expect(resolveRequestSignIn('ready', {})).toEqual({});
    expect(resolveRequestSignIn('ready', undefined)).toEqual({});
    expect(resolveRequestSignIn('ready', null)).toEqual({});
  });

  it('after BLOCK_READY with a same-origin in-app returnUrl → carries it through', () => {
    expect(resolveRequestSignIn('ready', { returnUrl: '/models/1?modelVersionId=2' })).toEqual({
      returnUrl: '/models/1?modelVersionId=2',
    });
  });

  it('open-redirect guard: drops absolute / protocol-relative / non-path returnUrls (opens, defaults instead)', () => {
    // All unsafe values collapse to {} (open the modal, default to current page)
    // — never honored as a post-login redirect target.
    expect(resolveRequestSignIn('ready', { returnUrl: 'https://evil.com' })).toEqual({});
    expect(resolveRequestSignIn('ready', { returnUrl: '//evil.com' })).toEqual({});
    expect(resolveRequestSignIn('ready', { returnUrl: 'javascript:alert(1)' })).toEqual({});
    expect(resolveRequestSignIn('ready', { returnUrl: 'models/1' })).toEqual({});
    expect(resolveRequestSignIn('ready', { returnUrl: 42 as unknown as string })).toEqual({});
  });
});

describe('isSafeReturnUrl', () => {
  it('accepts same-origin in-app paths only', () => {
    expect(isSafeReturnUrl('/')).toBe(true);
    expect(isSafeReturnUrl('/models/1')).toBe(true);
    expect(isSafeReturnUrl('//evil.com')).toBe(false);
    expect(isSafeReturnUrl('https://evil.com')).toBe(false);
    expect(isSafeReturnUrl('models/1')).toBe(false);
    expect(isSafeReturnUrl(undefined)).toBe(false);
    expect(isSafeReturnUrl(42)).toBe(false);
  });
});
