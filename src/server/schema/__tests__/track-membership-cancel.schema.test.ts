import { describe, it, expect } from 'vitest';
import { trackActionSchema } from '../track.schema';

/**
 * Regression test for the Membership_Cancel analytics event.
 *
 * The event stopped being emitted on 2024-10-29 (commit c51091d8a / #1455)
 * when the Paddle Retain cancellation refactor dropped the only `trackAction`
 * call for it. PR #2306 re-instruments it in the Stripe/Paddle cancel success
 * handlers in `src/components/Stripe/MembershipChangePrevention.tsx`.
 *
 * Note: the original regression was a *missing caller* — the only
 * `trackAction` call was deleted — which a schema test cannot detect (it can
 * only check a payload that is actually passed to it). A full React render
 * test of the component, which could catch a missing caller, is not feasible
 * in this harness (vitest runs in the `node` environment, only `*.test.ts` is
 * collected, and there is no @testing-library/react dependency).
 *
 * What this test does cover is the *payload contract*: the exact
 * `{ type, details }` shape both buttons pass to `trackAction` must be a valid
 * `trackActionSchema` input — the same schema `trpc.track.addAction` validates
 * against server-side. If the emitted shape ever drifts from the schema, the
 * event would again silently fail validation, and this test catches that.
 */
describe('Membership_Cancel trackAction payload', () => {
  it('accepts the cancel-path payload emitted by MembershipChangePrevention', () => {
    // Mirrors the literal object StripeCancelMembershipButton (method: 'stripe')
    // and PaddleCancelMembershipButton (method: 'paddle') pass to trackAction on
    // confirmed cancel.
    for (const method of ['stripe', 'paddle'] as const) {
      const payload = {
        type: 'Membership_Cancel' as const,
        details: { reason: '', from: 'gold', method },
      };

      const result = trackActionSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('Membership_Cancel');
      }
    }
  });

  it('accepts an empty `from` (fromTier ?? "" fallback when tier is unknown)', () => {
    const result = trackActionSchema.safeParse({
      type: 'Membership_Cancel',
      details: { reason: '', from: '' },
    });
    expect(result.success).toBe(true);
  });

  it('discriminates Membership_Cancel from other tracked action types', () => {
    const result = trackActionSchema.safeParse({
      type: 'Membership_Cancel',
      details: { reason: '', from: 'bronze' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).not.toBe('Membership_Downgrade');
    }
  });

  it('rejects a Membership_Cancel payload missing required detail fields', () => {
    // `reason` and `from` are both required strings on the details object —
    // guards against a partial payload silently passing.
    const result = trackActionSchema.safeParse({
      type: 'Membership_Cancel',
      details: { reason: '' },
    });
    expect(result.success).toBe(false);
  });
});
