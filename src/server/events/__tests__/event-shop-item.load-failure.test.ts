import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// The event registry fails to load. Purchases of event items must refuse and
// log; the shop list must hide only event items and keep rendering the rest.
vi.mock('~/server/events', () => {
  throw new Error('event engine failed to load');
});

import {
  assertEventShopItemPurchasable,
  createEventShopItemVisibility,
} from '~/server/events/event-shop-item';

const eventItem = { event: 'any-event', team: 'any-team' };

describe('when the event registry cannot be loaded', () => {
  beforeEach(() => {
    loggingMock.logToAxiom.mockReset();
  });

  it('refuses an event-item purchase and logs the failure', async () => {
    await expect(
      assertEventShopItemPurchasable({ userId: 1, data: eventItem, payWith: 'default' })
    ).rejects.toThrow('This item is not available right now');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: 'events: lazy load failed' })
    );
  });

  it('hides event items but still shows ordinary ones', async () => {
    const visible = createEventShopItemVisibility({ userId: 1 });

    expect(await visible(eventItem)).toBe(false);
    expect(await visible({ url: 'frame.png' })).toBe(true);
  });

  // A cached rejection would refuse every event item on the pod until restart.
  it('retries the load on the next call instead of keeping the failure', async () => {
    const visible = createEventShopItemVisibility({});
    await visible(eventItem);
    await visible(eventItem);

    const loadFailures = loggingMock.logToAxiom.mock.calls.filter(
      ([arg]) => (arg as { message?: string }).message === 'events: lazy load failed'
    );
    expect(loadFailures).toHaveLength(2);
  });
});
