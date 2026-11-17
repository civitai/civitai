import { describe, expect, it } from 'vitest';
import '~/__tests__/mocks/db.mock';

// The webhook tests replace toDateTime with vi.fn(), so this is the only suite that runs the
// real conversion. Every Stripe date on CustomerSubscription goes through it.
import { toDateTime } from '~/server/services/stripe.service';

describe('toDateTime', () => {
  it('converts a Stripe unix timestamp to the same instant', () => {
    expect(toDateTime(1795573374).toISOString()).toBe('2026-11-25T02:22:54.000Z');
  });

  it('maps second 0 to the unix epoch', () => {
    expect(toDateTime(0).getTime()).toBe(0);
  });
});
