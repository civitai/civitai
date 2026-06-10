import { describe, expect, it } from 'vitest';
import { resolveRequestConsent } from '../requestConsentGate';

/**
 * Lazy-consent (REQUEST_CONSENT) — the host's handler must:
 *   (1) only open the consent UI once BLOCK_READY has landed (status==='ready'),
 *       so a pre-handshake block can't pop a permission modal before any
 *       interaction (same posture as REQUEST_SIGN_IN / OPEN_BUZZ_PURCHASE);
 *   (2) drop the request when there's nothing to consent to (no missing scopes);
 *   (3) grant the missing set the MINT computed — never scopes the block claims.
 *
 * resolveRequestConsent is the pure gate the handler delegates to. Origin +
 * event.source pinning is enforced upstream by usePostMessage (covered by
 * usePostMessage.test.ts) — these tests pin the readiness + non-empty gate,
 * mirroring resolveRequestSignIn.
 */
describe('resolveRequestConsent (REQUEST_CONSENT gate)', () => {
  const missing = ['ai:write:budgeted', 'buzz:read:self'];

  it('before BLOCK_READY → ignored (returns null), no consent UI', () => {
    expect(resolveRequestConsent('loading', missing)).toBeNull();
  });

  it('does not honor the request during timeout / fatal / no_token fallbacks', () => {
    expect(resolveRequestConsent('timeout', missing)).toBeNull();
    expect(resolveRequestConsent('fatal', missing)).toBeNull();
    expect(resolveRequestConsent('no_token', missing)).toBeNull();
  });

  it('after BLOCK_READY with nothing missing → no-op (returns null)', () => {
    expect(resolveRequestConsent('ready', [])).toBeNull();
    expect(resolveRequestConsent('ready', undefined as unknown as string[])).toBeNull();
  });

  it('after BLOCK_READY with missing scopes → returns the server-known missing set to grant', () => {
    expect(resolveRequestConsent('ready', missing)).toEqual(missing);
    expect(resolveRequestConsent('ready', ['ai:write:budgeted'])).toEqual(['ai:write:budgeted']);
  });
});
