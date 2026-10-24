import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StripeService from '~/server/services/stripe.service';

const { createCustomer } = vi.hoisted(() => ({
  createCustomer: vi.fn(async (..._a: unknown[]) => 'cus_1'),
}));

vi.mock('~/server/services/stripe.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StripeService>()),
  createCustomer,
}));

import { createCustomerHandler } from '~/server/controllers/stripe.controller';

type Args = Parameters<typeof createCustomerHandler>[0];
const call = (user: { id: number; email: string | null }, input?: unknown) =>
  createCustomerHandler({ ctx: { user }, input } as unknown as Args);

beforeEach(() => vi.clearAllMocks());

describe('stripe.createCustomer', () => {
  it('creates the customer for the signed-in user, whatever the request carries', async () => {
    await call({ id: 7, email: 'me@example.com' }, { id: 8, email: 'other@example.com' });

    expect(createCustomer).toHaveBeenCalledWith({ id: 7, email: 'me@example.com' });
  });

  it('refuses an account with no email', async () => {
    await expect(call({ id: 7, email: null })).rejects.toThrow('email required');
    expect(createCustomer).not.toHaveBeenCalled();
  });
});
