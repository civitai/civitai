import { createHash, createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  deriveAgentGatewayBearer,
  deriveAgentHooksToken,
  signAgentCallbackToken,
  signReviewAccessToken,
} from '~/server/services/blocks/review-session';

/**
 * AGENTIC MOD CODE-REVIEW (App Blocks P3) — unit coverage for the DERIVED agent
 * gateway secret (no storage / no migration).
 *
 *   - deriveAgentHooksToken is deterministic (same input → same output)
 *   - it differs by publishRequestId
 *   - it is DISTINCT from the callback bearer + the `mr` entry token over the
 *     same secret + id (domain separation)
 *   - it matches the exact reference construction (domain-separated HMAC-SHA256,
 *     hex) so an infra-template drift is caught
 *   - deriveAgentGatewayBearer = sha256("gw-" + hooksToken), hex, deterministic
 *   - both differ by secret
 */

const SECRET = 'test-nextauth-secret-cccccccccccccccccccc';
const PUBREQ_A = 'pubreq_0123456789ABCDEFGHJKMNPQRS';
const PUBREQ_B = 'pubreq_ZZZZZZZZZZZZZZZZZZZZZZZZZZ';

describe('deriveAgentHooksToken', () => {
  it('is deterministic: same (secret, publishRequestId) → same hex token', () => {
    const a = deriveAgentHooksToken(PUBREQ_A, { secret: SECRET });
    const b = deriveAgentHooksToken(PUBREQ_A, { secret: SECRET });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // hex sha256
  });

  it('differs by publishRequestId', () => {
    expect(deriveAgentHooksToken(PUBREQ_A, { secret: SECRET })).not.toBe(
      deriveAgentHooksToken(PUBREQ_B, { secret: SECRET })
    );
  });

  it('differs by secret', () => {
    expect(deriveAgentHooksToken(PUBREQ_A, { secret: SECRET })).not.toBe(
      deriveAgentHooksToken(PUBREQ_A, { secret: 'other-secret' })
    );
  });

  it('matches the reference construction (domain-separated HMAC-SHA256, hex)', () => {
    const expected = createHmac('sha256', SECRET)
      .update(`agent-review-hooks:v1:${PUBREQ_A}`)
      .digest('hex');
    expect(deriveAgentHooksToken(PUBREQ_A, { secret: SECRET })).toBe(expected);
  });

  it('is DISTINCT from the callback bearer and the mr entry token (domain sep)', () => {
    const hooks = deriveAgentHooksToken(PUBREQ_A, { secret: SECRET });
    const callback = signAgentCallbackToken({ publishRequestId: PUBREQ_A, secret: SECRET });
    const mr = signReviewAccessToken({ modUserId: 1, host: 'review-x.civit.ai', secret: SECRET });
    expect(hooks).not.toBe(callback);
    expect(hooks).not.toBe(mr);
    // The callback + mr tokens are compact `payload.sig`; the hooks token is bare
    // hex (no dot) — they can never be confused on the wire.
    expect(hooks).not.toContain('.');
  });
});

describe('deriveAgentGatewayBearer', () => {
  it('equals sha256("gw-" + hooksToken) (hex), deterministic', () => {
    const hooks = deriveAgentHooksToken(PUBREQ_A, { secret: SECRET });
    const expected = createHash('sha256').update(`gw-${hooks}`).digest('hex');
    const bearer = deriveAgentGatewayBearer(PUBREQ_A, { secret: SECRET });
    expect(bearer).toBe(expected);
    expect(bearer).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic recompute (the invariant the pod relies on).
    expect(deriveAgentGatewayBearer(PUBREQ_A, { secret: SECRET })).toBe(bearer);
  });

  it('differs by publishRequestId and by secret; is NOT the raw hooks token', () => {
    const bearer = deriveAgentGatewayBearer(PUBREQ_A, { secret: SECRET });
    expect(bearer).not.toBe(deriveAgentGatewayBearer(PUBREQ_B, { secret: SECRET }));
    expect(bearer).not.toBe(deriveAgentGatewayBearer(PUBREQ_A, { secret: 'other-secret' }));
    expect(bearer).not.toBe(deriveAgentHooksToken(PUBREQ_A, { secret: SECRET }));
  });
});
