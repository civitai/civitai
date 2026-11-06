import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDetailLoader, DETAIL_SETTLE_MS } from './fetch-detail';
import type { TicketPayload } from '$lib/server/tickets/detail';

const payload = (id: string) => ({ ticket: { id } } as unknown as TicketPayload);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createDetailLoader', () => {
  it('reads only the ticket the selection settles on', async () => {
    const fetchPayload = vi.fn(async (id: string) => payload(id));
    const { load } = createDetailLoader(fetchPayload);
    const first = load('1', 'support');
    await vi.advanceTimersByTimeAsync(DETAIL_SETTLE_MS - 1);
    load('2', 'support');
    const last = load('3', 'support');
    await vi.advanceTimersByTimeAsync(DETAIL_SETTLE_MS);
    expect(fetchPayload.mock.calls.map(([id]) => id)).toEqual(['3']);
    expect(await last).toMatchObject({ ok: true });
    expect(await first).toMatchObject({ ok: false });
  });

  it('reads nothing once cancelled, as when the pane is destroyed', async () => {
    const fetchPayload = vi.fn(async (id: string) => payload(id));
    const { load, cancel } = createDetailLoader(fetchPayload);
    void load('1', 'support');
    cancel();
    await vi.advanceTimersByTimeAsync(DETAIL_SETTLE_MS * 2);
    expect(fetchPayload).not.toHaveBeenCalled();
  });

  it('re-reads the same ticket at once, as after a write', async () => {
    const fetchPayload = vi.fn(async (id: string) => payload(id));
    const { load } = createDetailLoader(fetchPayload);
    const first = load('1', 'support');
    await vi.advanceTimersByTimeAsync(DETAIL_SETTLE_MS);
    await first;
    await load('1', 'support');
    expect(fetchPayload).toHaveBeenCalledTimes(2);
  });

  it('keeps the last read of the same ticket when a re-read fails, and says why', async () => {
    const fetchPayload = vi
      .fn<(id: string) => Promise<TicketPayload>>()
      .mockResolvedValueOnce(payload('1'))
      .mockRejectedValueOnce(new Error('Freshdesk is down.'));
    const { load } = createDetailLoader(fetchPayload);
    const first = load('1', 'support');
    await vi.advanceTimersByTimeAsync(DETAIL_SETTLE_MS);
    await first;
    expect(await load('1', 'support')).toEqual({
      ok: true,
      payload: payload('1'),
      stale: 'Freshdesk is down.',
    });
  });

  it('reports the failure when there is nothing of that ticket to keep', async () => {
    const { load } = createDetailLoader(async () => {
      throw new Error('Not a support ticket.');
    });
    const res = load('1', 'support');
    await vi.advanceTimersByTimeAsync(DETAIL_SETTLE_MS);
    expect(await res).toEqual({ ok: false, message: 'Not a support ticket.' });
  });
});
