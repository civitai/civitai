import { useReducedMotion } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';
import { useMutateCosmeticShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import type {
  MysteryBoxOpenResult,
  MysteryBoxSource,
  MysteryBoxView,
} from '~/components/MysteryBox/mystery-box.utils';
import { afterHeldOpen, afterOpen, boxEventOf } from '~/components/MysteryBox/mystery-box.utils';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Where a buy-and-open is. The reward is drawn and granted by the end of `opening`; everything after
 * is the show, and closing it loses nothing.
 */
export type OpenPhase =
  | 'idle'
  | 'buying'
  | 'opening'
  | 'shaking'
  | 'glowing'
  | 'lidOff'
  | 'revealed';

/** The open and the purchase refuse a box edited since the viewer was shown its odds. */
const isBoxChangedError = (error: unknown) =>
  /contents changed/i.test((error as { message?: unknown } | null)?.message?.toString() ?? '');

// How long each beat of the show lasts, in ms.
const SHOW = { shaking: 1000, glowing: 500, lidOff: 450 } as const;

export function useMysteryBoxViews(source: MysteryBoxSource) {
  const forEvent = trpc.mysteryBox.getForEvent.useQuery(
    { event: 'event' in source ? source.event : '' },
    { enabled: 'event' in source }
  );
  const held = trpc.mysteryBox.getHeld.useQuery(undefined, { enabled: 'inventory' in source });
  const query = 'event' in source ? forEvent : held;
  return { views: query.data as MysteryBoxView[] | undefined, isLoading: query.isLoading };
}

/**
 * Buys and opens a mystery box, or opens one already held, then plays the reveal. The purchase is
 * the shop's own (its intent key, its refusals); the open names the version the viewer was shown.
 */
export function useMysteryBoxOpen(source: MysteryBoxSource) {
  const utils = trpc.useUtils();
  const reduceMotion = useReducedMotion();
  const { purchaseShopItem } = useMutateCosmeticShop();
  const openMutation = trpc.mysteryBox.open.useMutation();
  const [phase, setPhase] = useState<OpenPhase>('idle');
  const [result, setResult] = useState<MysteryBoxOpenResult>();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Mid purchase or open. The show after it can be skipped or followed by another.
  const busy = phase === 'buying' || phase === 'opening';
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // checkNotifications is never refetched (staleTime: Infinity), so the menu badge is patched here.
  const addToUnopenedCount = (change: number) =>
    utils.user.checkNotifications.setData(
      undefined,
      (counts) => counts && { ...counts, unopenedBoxes: Math.max(0, counts.unopenedBoxes + change) }
    );
  const recordPurchase = (boxDefinitionId: number, boxItemId: string) => {
    if ('event' in source)
      utils.mysteryBox.getForEvent.setData({ event: source.event }, (views) =>
        views?.map((view) =>
          view.boxDefinitionId === boxDefinitionId && !view.heldBoxItemIds.includes(boxItemId)
            ? { ...view, heldBoxItemIds: [...view.heldBoxItemIds, boxItemId] }
            : view
        )
      );
    addToUnopenedCount(1);
    void utils.mysteryBox.getHeld.invalidate();
  };
  // Write the modal's own read, don't refetch: a lagging replica could still answer "unopened". The
  // other page's read is invalidated, not written, since a write marks it fresh.
  const recordOpen = (view: MysteryBoxView, opened: MysteryBoxOpenResult) => {
    const event = boxEventOf(source, view);
    const isThisBox = (other: MysteryBoxView) => other.boxDefinitionId === view.boxDefinitionId;
    if ('event' in source) {
      utils.mysteryBox.getForEvent.setData({ event: source.event }, (views) =>
        views?.map((other) => (isThisBox(other) ? afterOpen(other, opened) : other))
      );
      void utils.mysteryBox.getHeld.invalidate();
    } else {
      utils.mysteryBox.getHeld.setData(undefined, (views) =>
        views?.map((other) => (isThisBox(other) ? afterHeldOpen(other, opened) : other))
      );
      if (event) void utils.mysteryBox.getForEvent.invalidate({ event });
    }
    addToUnopenedCount(-1);
    void utils.mysteryBox.getOpenings.invalidate();
    if (event) void utils.event.getMyHats.invalidate({ event });
  };
  const refresh = () =>
    'event' in source
      ? utils.mysteryBox.getForEvent.invalidate({ event: source.event })
      : utils.mysteryBox.getHeld.invalidate();

  const playShow = () => {
    if (reduceMotion) return setPhase('revealed');
    setPhase('shaking');
    let at = 0;
    for (const [next, after] of [
      ['glowing', SHOW.shaking],
      ['lidOff', SHOW.glowing],
      ['revealed', SHOW.lidOff],
    ] as const) {
      at += after;
      timers.current.push(setTimeout(() => setPhase(next), at));
    }
  };

  const open = async (view: MysteryBoxView, boxItemId: string) => {
    setPhase('opening');
    try {
      const opened = await openMutation.mutateAsync({ boxItemId, expectedVersion: view.version });
      setResult(opened);
      recordOpen(view, opened);
      playShow();
      return opened;
    } catch (error) {
      setPhase('idle');
      void refresh();
      showErrorNotification(
        isBoxChangedError(error)
          ? {
              title: 'The contents changed',
              error: error as Error,
              reason: 'Here are the new odds. Your box is safe and still unopened.',
            }
          : {
              title: 'Your box is safe',
              error: error as Error,
              reason:
                'event' in source
                  ? 'It stays with you, unopened. Open it again from your Inventory.'
                  : 'It stays with you, unopened. Try opening it again.',
            }
      );
    }
  };

  const buyAndOpen = async (view: MysteryBoxView) => {
    if (!view.listing || busy) return;
    setResult(undefined);
    setPhase('buying');
    let bought;
    try {
      bought = await purchaseShopItem({
        shopItemId: view.listing.shopItemId,
        expectedUnitAmount: view.listing.unitAmount,
        expectedVersion: view.version,
      });
    } catch {
      // The shop's hook shows why. A changed box or price shows its new odds.
      setPhase('idle');
      void refresh();
      return;
    }
    if (!bought || !('kind' in bought) || bought.kind !== 'box') {
      // Bought under this intent already, and opened since: nothing to open here.
      setPhase('idle');
      void refresh();
      return;
    }
    const { boxItemId } = bought;
    recordPurchase(view.boxDefinitionId, boxItemId);
    return open(view, boxItemId);
  };

  const openHeld = async (view: MysteryBoxView, preferred?: string) => {
    const boxItemId =
      preferred && view.heldBoxItemIds.includes(preferred) ? preferred : view.heldBoxItemIds[0];
    if (!boxItemId || busy) return;
    setResult(undefined);
    return open(view, boxItemId);
  };

  const reset = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPhase('idle');
    setResult(undefined);
  };

  return { phase, result, buyAndOpen, openHeld, reset, busy };
}
