import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * Every checkout path creates its Stripe customer through `createCustomer` and charges whichever id it
 * returns. Two first checkouts at once must end on the one customer the account row records, or one
 * payment lands on a customer no account is linked to.
 */

const { customers } = vi.hoisted(() => ({
  customers: { create: vi.fn(), del: vi.fn() },
}));

vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: async () => ({ customers }),
}));

import { createCustomer } from '~/server/services/stripe.service';

const USER_ID = 42;
let row: { id: number; customerId: string | null };
let created = 0;

beforeEach(() => {
  vi.clearAllMocks();
  // Drops any one-off reply a test queued and did not use, so it cannot answer the next test.
  for (const fn of [
    customers.create,
    customers.del,
    dbMock.dbWrite.user.findUnique,
    dbMock.dbWrite.user.update,
    dbMock.dbWrite.user.updateMany,
  ])
    fn.mockReset();
  row = { id: USER_ID, customerId: null };
  created = 0;
  customers.create.mockImplementation(async () => ({ id: `cus_${++created}` }));
  customers.del.mockResolvedValue({ deleted: true });
  dbMock.dbWrite.user.findUnique.mockImplementation(async () => ({ ...row }));
  dbMock.dbWrite.user.update.mockImplementation(async ({ data }: any) => Object.assign(row, data));
  dbMock.dbWrite.user.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (where.customerId !== undefined && row.customerId !== where.customerId) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
});

// Both checkouts read the account before either has created its customer.
function bothReadFirst() {
  const read = dbMock.dbWrite.user.findUnique.getMockImplementation()!;
  let arrived = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => (release = resolve));
  dbMock.dbWrite.user.findUnique.mockImplementation(async (args: any) => {
    const result = await read(args);
    if (++arrived === 2) release();
    if (arrived <= 2) await bothRead;
    return result;
  });
}

describe('createCustomer', () => {
  it('returns the one recorded customer to two checkouts that start at once', async () => {
    bothReadFirst();

    const ids = await Promise.all([
      createCustomer({ id: USER_ID, email: 'a@example.com' }),
      createCustomer({ id: USER_ID, email: 'a@example.com' }),
    ]);

    expect(customers.create).toHaveBeenCalledTimes(2);
    expect(ids[0]).toBe(row.customerId);
    expect(ids[1]).toBe(row.customerId);
    // The unused customer is removed, and its id reaches no caller.
    expect(customers.del).toHaveBeenCalledTimes(1);
    const [unused] = customers.del.mock.calls[0];
    expect(unused).not.toBe(row.customerId);
    expect(ids).not.toContain(unused);
  });

  it('removes the customer it created when the account is gone', async () => {
    dbMock.dbWrite.user.updateMany.mockResolvedValue({ count: 0 });
    dbMock.dbWrite.user.findUnique.mockResolvedValueOnce({ customerId: null });
    dbMock.dbWrite.user.findUnique.mockResolvedValueOnce(null);

    await expect(createCustomer({ id: USER_ID, email: 'a@example.com' })).rejects.toThrow(
      `No user with id ${USER_ID}`
    );
    expect(customers.del).toHaveBeenCalledWith('cus_1');
  });

  it('returns the recorded customer and creates none', async () => {
    row.customerId = 'cus_existing';

    expect(await createCustomer({ id: USER_ID, email: 'a@example.com' })).toBe('cus_existing');
    expect(customers.create).not.toHaveBeenCalled();
    expect(customers.del).not.toHaveBeenCalled();
  });

  it('links the customer it creates to the account', async () => {
    await createCustomer({ id: USER_ID, email: 'a@example.com' });

    expect(customers.create).toHaveBeenCalledWith({
      email: 'a@example.com',
      metadata: { userId: String(USER_ID) },
    });
    expect(row.customerId).toBe('cus_1');
    expect(customers.del).not.toHaveBeenCalled();
  });

  it('still returns the recorded customer when removing the unused one fails', async () => {
    bothReadFirst();
    customers.del.mockRejectedValue(new Error('stripe unavailable'));

    const ids = await Promise.all([
      createCustomer({ id: USER_ID, email: 'a@example.com' }),
      createCustomer({ id: USER_ID, email: 'a@example.com' }),
    ]);

    expect(ids).toEqual([row.customerId, row.customerId]);
    const [unused] = customers.del.mock.calls[0];
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'stripe-unused-customer-delete',
        userId: USER_ID,
        customerId: row.customerId,
        unusedCustomerId: unused,
      })
    );
  });
});
