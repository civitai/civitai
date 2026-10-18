// @vitest-environment happy-dom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

/**
 * Buy and open on the client: the purchase is the shop's, under the version and price the viewer
 * was shown; the open follows only a purchase that granted a box; a failed open leaves the box held
 * in the view, so the card offers to open it.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { spies } = vi.hoisted(() => ({
  spies: {
    purchase: vi.fn(),
    open: vi.fn(),
    setData: vi.fn(),
    invalidateBoxes: vi.fn(),
    invalidateHats: vi.fn(),
    setHeld: vi.fn(),
    invalidateHeld: vi.fn(),
    invalidateOpenings: vi.fn(),
    setCounts: vi.fn(),
    notify: vi.fn(),
    reducedMotion: { value: false },
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(
    { 'mysteryBox.open': { useMutation: () => ({ mutateAsync: spies.open }) } },
    {
      useUtils: () => ({
        mysteryBox: {
          getForEvent: { setData: spies.setData, invalidate: spies.invalidateBoxes },
          getHeld: { setData: spies.setHeld, invalidate: spies.invalidateHeld },
          getOpenings: { invalidate: spies.invalidateOpenings },
        },
        event: { getMyHats: { invalidate: spies.invalidateHats } },
        user: { checkNotifications: { setData: spies.setCounts } },
      }),
    }
  ),
}));
vi.mock('~/components/CosmeticShop/cosmetic-shop.util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMutateCosmeticShop: () => ({ purchaseShopItem: spies.purchase }),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showErrorNotification: spies.notify,
}));
vi.mock('@mantine/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useReducedMotion: () => spies.reducedMotion.value,
}));

import { useMysteryBoxOpen } from '../useMysteryBoxOpen';
import type { HeldMysteryBox, MysteryBoxSource, MysteryBoxView } from '../mystery-box.utils';

const view = (overrides: Partial<MysteryBoxView> = {}): MysteryBoxView => ({
  boxDefinitionId: 9,
  name: 'Box',
  description: null,
  version: 3,
  team: 'Pink',
  art: null,
  listing: { shopItemId: 42, title: 'Box', unitAmount: 500, availableTo: null },
  tiers: [{ id: 7, key: 'common', name: 'Common', color: null, weight: 1, sortOrder: 0 }],
  contents: [
    { contentId: 1, tierId: 7, cosmeticId: 1001, name: 'A', url: null, fit: null, left: true },
    { contentId: 2, tierId: 7, cosmeticId: 1002, name: 'B', url: null, fit: null, left: true },
  ],
  heldBoxItemIds: [],
  ...overrides,
});
const opened = (boxItemId = '501') => ({
  boxItemId,
  boxDefinitionId: 9,
  boxVersion: 3,
  tierId: 7,
  contentId: 2,
  rewardDefinitionId: 102,
  rewardType: 'cosmetic',
  cosmeticId: 1002,
  odds: { tierWeight: 1, eligibleWeight: 1, tierPoolSize: 2 },
  replayed: false,
});

let hook: ReturnType<typeof useMysteryBoxOpen>;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let source: MysteryBoxSource = { event: 'birthday2026' };
function Harness() {
  hook = useMysteryBoxOpen(source);
  return null;
}

const unopenedAfterUpdates = (start: number) =>
  spies.setCounts.mock.calls.reduce(
    (counts: { unopenedBoxes: number }, [, update]) => update(counts),
    { unopenedBoxes: start }
  ).unopenedBoxes;

/** Applies every `setData` updater the hook made, in order, to a starting view. */
const viewAfterUpdates = (start: MysteryBoxView) =>
  spies.setData.mock.calls.reduce(
    (views: MysteryBoxView[], [, update]) => update(views),
    [start]
  )[0];

beforeEach(async () => {
  vi.useFakeTimers();
  for (const spy of Object.values(spies)) if (typeof spy === 'function') spy.mockReset();
  spies.reducedMotion.value = false;
  source = { event: 'birthday2026' };
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(React.createElement(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe('useMysteryBoxOpen', () => {
  it('buys under the shown price and version, opens the box it granted, then plays the show', async () => {
    spies.purchase.mockResolvedValue({ kind: 'box', boxItemId: '501', boxDefinitionId: 9 });
    spies.open.mockResolvedValue(opened());

    await act(async () => {
      await hook.buyAndOpen(view());
    });

    expect(spies.purchase).toHaveBeenCalledWith({
      shopItemId: 42,
      expectedUnitAmount: 500,
      expectedVersion: 3,
    });
    expect(spies.open).toHaveBeenCalledWith({ boxItemId: '501', expectedVersion: 3 });
    expect(hook.result?.contentId).toBe(2);
    // The drawn hat is no longer left and the box is no longer held, without a refetch.
    const after = viewAfterUpdates(view());
    expect(after.contents.map((c) => c.left)).toEqual([true, false]);
    expect(after.heldBoxItemIds).toEqual([]);
    expect(spies.invalidateBoxes).not.toHaveBeenCalled();
    for (const [key] of spies.setData.mock.calls) expect(key).toEqual({ event: 'birthday2026' });
    expect(spies.invalidateHats).toHaveBeenCalledWith({ event: 'birthday2026' });
    // Bought and opened: the menu badge ends where it began, and the Inventory reloads when shown.
    expect(unopenedAfterUpdates(2)).toBe(2);
    expect(spies.setHeld).not.toHaveBeenCalled();
    expect(spies.invalidateHeld).toHaveBeenCalled();
    expect(spies.invalidateOpenings).toHaveBeenCalled();

    expect(hook.phase).toBe('shaking');
    await act(async () => vi.advanceTimersByTime(1000));
    expect(hook.phase).toBe('glowing');
    await act(async () => vi.advanceTimersByTime(500));
    expect(hook.phase).toBe('lidOff');
    await act(async () => vi.advanceTimersByTime(450));
    expect(hook.phase).toBe('revealed');
  });

  it('goes straight to the reveal with reduced motion', async () => {
    spies.reducedMotion.value = true;
    await act(async () => root.render(React.createElement(Harness)));
    spies.purchase.mockResolvedValue({ kind: 'box', boxItemId: '501', boxDefinitionId: 9 });
    spies.open.mockResolvedValue(opened());

    await act(async () => {
      await hook.buyAndOpen(view());
    });

    expect(hook.phase).toBe('revealed');
  });

  it('never opens when the purchase is refused, and reloads the odds', async () => {
    spies.purchase.mockRejectedValue(
      new Error("This box's contents changed. Check them and try again.")
    );

    await act(async () => {
      await hook.buyAndOpen(view());
    });

    expect(spies.open).not.toHaveBeenCalled();
    expect(hook.phase).toBe('idle');
    expect(spies.invalidateBoxes).toHaveBeenCalledWith({ event: 'birthday2026' });
  });

  it('never opens after a purchase that was already completed and opened', async () => {
    spies.purchase.mockResolvedValue({ alreadyCompleted: true });

    await act(async () => {
      await hook.buyAndOpen(view());
    });

    expect(spies.open).not.toHaveBeenCalled();
    expect(hook.phase).toBe('idle');
  });

  it('keeps the bought box held when its open fails, and says the box is safe', async () => {
    spies.purchase.mockResolvedValue({ kind: 'box', boxItemId: '501', boxDefinitionId: 9 });
    spies.open.mockRejectedValue(new Error('This box could not be opened. Please try again.'));

    await act(async () => {
      await hook.buyAndOpen(view());
    });

    expect(viewAfterUpdates(view()).heldBoxItemIds).toEqual(['501']);
    expect(unopenedAfterUpdates(0)).toBe(1);
    expect(hook.phase).toBe('idle');
    expect(spies.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Your box is safe' })
    );
  });

  it('says the contents changed when the open names an old version', async () => {
    spies.open.mockRejectedValue(
      new Error("This box's contents changed. Check them and try again.")
    );

    await act(async () => {
      await hook.openHeld(view({ heldBoxItemIds: ['501'] }));
    });

    expect(spies.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'The contents changed' })
    );
    expect(spies.invalidateBoxes).toHaveBeenCalledWith({ event: 'birthday2026' });
  });

  it('opens the oldest held box under the shown version, without buying', async () => {
    spies.open.mockResolvedValue(opened('501'));

    await act(async () => {
      await hook.openHeld(view({ heldBoxItemIds: ['501', '502'] }));
    });

    expect(spies.purchase).not.toHaveBeenCalled();
    expect(spies.open).toHaveBeenCalledWith({ boxItemId: '501', expectedVersion: 3 });
  });

  it('ignores a second press while a purchase is on its way', async () => {
    let finish!: (value: unknown) => void;
    spies.purchase.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    spies.open.mockResolvedValue(opened());

    await act(async () => {
      void hook.buyAndOpen(view());
    });
    await act(async () => {
      await hook.buyAndOpen(view());
    });
    await act(async () => {
      finish({ kind: 'box', boxItemId: '501', boxDefinitionId: 9 });
    });

    expect(spies.purchase).toHaveBeenCalledTimes(1);
    expect(spies.open).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a box no longer sold, or with none held', async () => {
    await act(async () => {
      await hook.buyAndOpen(view({ listing: null }));
      await hook.openHeld(view());
    });

    expect(spies.purchase).not.toHaveBeenCalled();
    expect(spies.open).not.toHaveBeenCalled();
    expect(hook.phase).toBe('idle');
    expect(spies.invalidateBoxes).not.toHaveBeenCalled();
  });

  it('ignores a second open while the first is on its way', async () => {
    let finish!: (value: unknown) => void;
    spies.open.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const held = view({ heldBoxItemIds: ['501', '502'] });

    await act(async () => {
      void hook.openHeld(held);
    });
    await act(async () => {
      await hook.openHeld(held);
    });
    await act(async () => {
      finish(opened('501'));
    });

    expect(spies.open).toHaveBeenCalledTimes(1);
  });
});

describe('useMysteryBoxOpen from the Inventory', () => {
  const heldView = (overrides: Partial<HeldMysteryBox> = {}): HeldMysteryBox => ({
    ...view({ listing: null, heldBoxItemIds: ['501', '502'] }),
    event: 'birthday2026',
    heldItems: [
      { id: '501', acquiredAt: new Date('2026-11-01') },
      { id: '502', acquiredAt: new Date('2026-11-02') },
    ],
    ...overrides,
  });

  beforeEach(async () => {
    source = { inventory: true };
    await act(async () => root.render(React.createElement(Harness)));
  });

  it('opens the box the viewer picked, not the first one held', async () => {
    spies.open.mockResolvedValue(opened('502'));

    await act(async () => {
      await hook.openHeld(heldView(), '502');
    });

    expect(spies.open).toHaveBeenCalledWith({ boxItemId: '502', expectedVersion: 3 });
  });

  it('falls back to the first held box when the picked one is no longer held', async () => {
    spies.open.mockResolvedValue(opened('501'));

    await act(async () => {
      await hook.openHeld(heldView(), '999');
    });

    expect(spies.open).toHaveBeenCalledWith({ boxItemId: '501', expectedVersion: 3 });
  });

  it("writes the open into the Inventory's own read and marks the event page's stale", async () => {
    spies.open.mockResolvedValue(opened('502'));

    await act(async () => {
      await hook.openHeld(heldView(), '502');
    });

    expect(spies.setHeld).toHaveBeenCalledTimes(1);
    const [key, update] = spies.setHeld.mock.calls[0];
    expect(key).toBeUndefined();
    const [after] = update([heldView()]) as HeldMysteryBox[];
    expect(after.heldItems.map((i) => i.id)).toEqual(['501']);
    expect(after.heldBoxItemIds).toEqual(['501']);
    expect(after.contents.map((c) => c.left)).toEqual([true, false]);
    expect(spies.invalidateHeld).not.toHaveBeenCalled();
    expect(spies.setData).not.toHaveBeenCalled();
    expect(spies.invalidateBoxes).toHaveBeenCalledWith({ event: 'birthday2026' });
    expect(spies.invalidateHats).toHaveBeenCalledWith({ event: 'birthday2026' });
    expect(unopenedAfterUpdates(2)).toBe(1);
  });

  it('never takes the menu badge below zero', async () => {
    spies.open.mockResolvedValue(opened('502'));

    await act(async () => {
      await hook.openHeld(heldView(), '502');
    });

    expect(unopenedAfterUpdates(0)).toBe(0);
  });

  it('touches no event read for a box with no event', async () => {
    spies.open.mockResolvedValue(opened('501'));

    await act(async () => {
      await hook.openHeld(heldView({ event: null }));
    });

    expect(spies.invalidateBoxes).not.toHaveBeenCalled();
    expect(spies.invalidateHats).not.toHaveBeenCalled();
    expect(spies.setHeld).toHaveBeenCalledTimes(1);
  });

  it('reloads the Inventory, not an event page, when the open fails', async () => {
    spies.open.mockRejectedValue(new Error('This box could not be opened. Please try again.'));

    await act(async () => {
      await hook.openHeld(heldView(), '502');
    });

    expect(spies.invalidateHeld).toHaveBeenCalled();
    expect(spies.invalidateBoxes).not.toHaveBeenCalled();
    expect(unopenedAfterUpdates(2)).toBe(2);
  });
});
