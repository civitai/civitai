import { describe, expect, it, vi } from 'vitest';

vi.mock('~/env/server', () => ({ env: {} }));

import type { TipaltiCaller as TipaltiCallerInstance } from '~/server/http/tipalti/tipalti.caller';

const { TipaltiCaller } = await import('~/server/http/tipalti/tipalti.caller');

const callerAnswering = (status: number, body?: unknown) => {
  const caller = Object.create(TipaltiCaller.prototype) as TipaltiCallerInstance;
  caller.getRaw = vi.fn(async () => new Response(body ? JSON.stringify(body) : null, { status }));
  return caller;
};

const payment = (id: string) => ({ id, fees: [] });

// The paymentError webhook refunds fees from this record; a guessed or missing one refunds wrong.
describe('TipaltiCaller.getPaymentByRefCode', () => {
  it('answers null only when Tipalti has no such payment', async () => {
    await expect(callerAnswering(404).getPaymentByRefCode('CW1_abcd')).resolves.toBeNull();
    await expect(
      callerAnswering(200, { items: [], totalCount: 0 }).getPaymentByRefCode('CW1_abcd')
    ).resolves.toBeNull();
  });

  it('throws on any other failed response instead of answering null', async () => {
    await expect(callerAnswering(500).getPaymentByRefCode('CW1_abcd')).rejects.toThrow('500');
  });

  it('throws when the refCode matches more than one payment', async () => {
    const caller = callerAnswering(200, { items: [payment('a'), payment('b')], totalCount: 2 });
    await expect(caller.getPaymentByRefCode('CW1_abcd')).rejects.toThrow('2 Tipalti payments');
  });

  it('returns the one payment the refCode matches', async () => {
    const caller = callerAnswering(200, { items: [payment('a')], totalCount: 1 });
    await expect(caller.getPaymentByRefCode('CW1_abcd')).resolves.toEqual(payment('a'));
    expect(caller.getRaw).toHaveBeenCalledWith('/payments', {
      queryParams: { filter: 'refCode=="CW1_abcd"' },
    });
  });
});
