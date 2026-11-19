import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';

/**
 * An event donation is refused before any Buzz moves when the event has ended or takes no
 * donations, as a 400. The donate route was callable for a finished event: its page hides the
 * input, but a request still charged the donor for a team that can no longer score.
 */

const { createBuzzTransaction } = vi.hoisted(() => ({ createBuzzTransaction: vi.fn() }));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransaction,
}));

import { eventEngine } from '~/server/events';
import { birthday2026 } from '~/server/events/birthday2026.event';
import { holiday2024 } from '~/server/events/holiday2024.event';
import { donate } from '~/server/services/event.service';

const DONOR = 77;

beforeEach(() => {
  vi.restoreAllMocks();
  createBuzzTransaction.mockReset().mockResolvedValue({ transactionId: 'tx-1' });
  // The donor is on a team with a bank account, so nothing but the event's own state stands
  // between this request and the charge.
  vi.spyOn(eventEngine, 'getUserData').mockResolvedValue({
    team: 'Red',
    accountId: -110,
  } as never);
  vi.spyOn(eventEngine, 'getEventData').mockResolvedValue({
    title: 'An event',
    startDate: new Date('2024-12-14T00:00:00.000Z'),
    endDate: new Date('2025-01-01T08:00:00.000Z'),
  } as never);
  vi.spyOn(holiday2024, 'getUserCosmeticId').mockResolvedValue(undefined as never);
});

describe('donating to an event', () => {
  it('refuses an event that has ended with a 400, and charges nothing', async () => {
    expect(holiday2024.bankIndex).toBeDefined();
    expect(holiday2024.endDate.getTime()).toBeLessThan(Date.now());

    await expect(
      donate({ event: holiday2024.name, userId: DONOR, amount: 100 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'This event has ended' });
    expect(createBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refuses an event that takes no donations with a 400, and charges nothing', async () => {
    expect(birthday2026.bankIndex).toBeUndefined();

    await expect(
      donate({ event: birthday2026.name, userId: DONOR, amount: 100 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'This event does not take donations' });
    expect(createBuzzTransaction).not.toHaveBeenCalled();
  });

  // The end is the boundary: a donation at the end itself is past it.
  it('treats the end instant as ended', async () => {
    await expect(
      eventEngine.donate(holiday2024.name, { userId: DONOR, amount: 100 }, holiday2024.endDate)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'This event has ended' });
    expect(createBuzzTransaction).not.toHaveBeenCalled();
  });

  // Negative control: the same event, one instant before its end, still charges the donor, so
  // the refusals above come from the event's state and not from this fixture.
  it('charges a donation to an event that is still running', async () => {
    const beforeEnd = new Date(holiday2024.endDate.getTime() - 1);

    await eventEngine.donate(holiday2024.name, { userId: DONOR, amount: 100 }, beforeEnd);

    expect(createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountId: DONOR, toAccountId: -110, amount: 100 })
    );
  });
});
