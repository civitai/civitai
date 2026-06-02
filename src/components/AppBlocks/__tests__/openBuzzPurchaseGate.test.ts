import { describe, expect, it } from 'vitest';
import { resolveBuzzPurchaseRequest } from '../openBuzzPurchaseGate';

/**
 * M-BUZZMODAL (audit medium / app-exploits-user) — the host's
 * OPEN_BUZZ_PURCHASE handler must NOT summon the Buy-Buzz spend modal before
 * the block has sent BLOCK_READY. resolveBuzzPurchaseRequest is the pure gate
 * the handler delegates to; these tests pin the readiness behavior.
 */
describe('resolveBuzzPurchaseRequest (M-BUZZMODAL)', () => {
  const validPayload = { requestId: 'req-1' };

  it('OPEN_BUZZ_PURCHASE before BLOCK_READY → no modal (returns null)', () => {
    expect(resolveBuzzPurchaseRequest('loading', validPayload)).toBeNull();
  });

  it('does not open during the timeout / fatal / no_token fallbacks either', () => {
    expect(resolveBuzzPurchaseRequest('timeout', validPayload)).toBeNull();
    expect(resolveBuzzPurchaseRequest('fatal', validPayload)).toBeNull();
    expect(resolveBuzzPurchaseRequest('no_token', validPayload)).toBeNull();
  });

  it('after BLOCK_READY (status=ready) → opens, returning the validated requestId', () => {
    expect(resolveBuzzPurchaseRequest('ready', validPayload)).toBe('req-1');
  });

  it('drops malformed payloads even when ready (missing / non-string / empty requestId)', () => {
    expect(resolveBuzzPurchaseRequest('ready', undefined)).toBeNull();
    expect(resolveBuzzPurchaseRequest('ready', null)).toBeNull();
    expect(resolveBuzzPurchaseRequest('ready', {})).toBeNull();
    expect(resolveBuzzPurchaseRequest('ready', { requestId: 42 as unknown as string })).toBeNull();
    expect(resolveBuzzPurchaseRequest('ready', { requestId: '' })).toBeNull();
  });
});
