import { useReducedMotion } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';
import { useMutateCosmeticShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import type {
  MysteryBoxOpenResult,
  MysteryBoxView,
} from '~/components/MysteryBox/mystery-box.utils';
import { afterOpen } from '~/components/MysteryBox/mystery-box.utils';
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

// How long each beat of the show lasts, in ms.
const SHOW = { shaking: 1000, glowing: 500, lidOff: 450 } as const;

/**
 * Buys and opens a mystery box, or opens one already held, then plays the reveal. The purchase is
 * the shop's own (its intent key, its refusals); the open names the version the viewer was shown.
 */
export function useMysteryBoxOpen(event: string) {
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

  const updateBox = (boxDefinitionId: number, update: (view: MysteryBoxView) => MysteryBoxView) =>
    utils.mysteryBox.getForEvent.setData({ event }, (views) =>
      views?.map((view) => (view.boxDefinitionId === boxDefinitionId ? update(view) : view))
    );
  const refresh = () => utils.mysteryBox.getForEvent.invalidate({ event });

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
      updateBox(view.boxDefinitionId, (current) => afterOpen(current, opened));
      void utils.event.getMyHats.invalidate({ event });
      void refresh();
      playShow();
      return opened;
    } catch (error) {
      setPhase('idle');
      void refresh();
      showErrorNotification({
        title: 'Your box is safe',
        error: error as Error,
        reason: 'It stays with you, unopened. Open it again from the box card.',
      });
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
    updateBox(view.boxDefinitionId, (current) => ({
      ...current,
      heldBoxItemIds: current.heldBoxItemIds.includes(boxItemId)
        ? current.heldBoxItemIds
        : [...current.heldBoxItemIds, boxItemId],
    }));
    return open(view, boxItemId);
  };

  const openHeld = async (view: MysteryBoxView) => {
    const boxItemId = view.heldBoxItemIds[0];
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
