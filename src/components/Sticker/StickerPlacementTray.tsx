import { CloseButton, Group, ScrollArea, Text } from '@mantine/core';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { useImagePlacementSpace } from '~/components/Sticker/placement.util';
import { stickerMaxScale } from '~/shared/utils/sticker-placement';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import { StickerTopUp } from '~/components/Sticker/StickerTopUp';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  pointerOverSurface,
  useStickerPlacementDraftStore,
} from '~/store/sticker-placement-draft.store';
import { trpc } from '~/utils/trpc';

/**
 * The placement affordance: a panel at the bottom of the viewport holding the
 * stickers you own, which you drag onto the image.
 *
 * Deliberately not a modal. A modal has to show its own copy of the image, at a
 * different size from the real one and behind a scrollbar — you end up
 * positioning a sticker on a picture of the picture. Dragging onto the actual
 * image is both simpler and the only way the result is what you saw.
 *
 * Centred and capped rather than spanning the viewport: full-width made a row of
 * three stickers sit in a field of empty panel, and pushed the instructions so
 * far from them that they read as unrelated.
 */
export function StickerPlacementTray({ imageId }: { imageId: number }) {
  const currentUser = useCurrentUser();
  const { sticker, isLoading } = useOwnedSticker();
  // The sticker they tried to place with nothing left. Buying uses here rather
  // than sending them to the shop is the point — a tray they have to leave is a
  // placement they don't make.
  const [topUp, setTopUp] = useState<ResolvedSticker | null>(null);
  // Being dragged, but not yet on the image. The only feedback during that
  // stretch, since nothing is drawn on the image until the pointer arrives.
  const [dragging, setDragging] = useState<number | null>(null);
  const endGrab = useRef<(() => void) | null>(null);
  const trayRef = useRef<HTMLDivElement>(null);

  // A gesture in flight when the tray closes would leave window listeners behind
  // and could drop a sticker onto an image nobody is looking at any more.
  useEffect(() => () => endGrab.current?.(), []);

  const targetImageId = useStickerPlacementDraftStore((state) => state.targetImageId);
  const trayOpen = useStickerPlacementDraftStore((state) => state.trayOpen);
  const drafts = useStickerPlacementDraftStore((state) => state.drafts);
  const begin = useStickerPlacementDraftStore((state) => state.begin);
  const closeTray = useStickerPlacementDraftStore((state) => state.closeTray);
  const setInteraction = useStickerPlacementDraftStore((state) => state.setInteraction);
  const setTray = useStickerPlacementDraftStore((state) => state.setTray);

  // Bound to this bar's own image, not merely to "a session exists". The
  // carousel keeps every slide's overlay mounted while the bar follows the
  // visible one, so a session left open on a previous slide would otherwise
  // keep the panel up showing that image's price and balances — and a drag from
  // it would measure the off-screen slide's surface and land a sticker on an
  // image nobody is looking at.
  const showing = targetImageId === imageId && trayOpen;

  // Registered after the early return below has been passed, so the element in
  // the store is always one that is actually on screen. `showing` rather than
  // the target alone: a panel that has been put away is not an obstacle the buy
  // button should still be avoiding.
  useEffect(() => {
    if (!showing) return;
    setTray(trayRef.current);
    return () => setTray(null);
  }, [showing, setTray]);

  const { space } = useImagePlacementSpace(targetImageId ?? undefined);
  const { data: balances } = trpc.cosmetic.getStickerBalances.useQuery(undefined, {
    enabled: !!currentUser && targetImageId != null,
  });

  if (!showing) return null;

  // `null` is unlimited and `undefined` is not loaded yet. Collapsing them
  // flashes "unlimited" on every open.
  //
  // Drafts already on the image are subtracted, because each one will spend a
  // use when it is bought. Without this you could lay out three with one use
  // left and only find out at the third purchase, having arranged all of them.
  const balanceFor = (cosmeticId: number) => {
    const remaining = balances?.find((balance) => balance.cosmeticId === cosmeticId)?.remaining;
    if (remaining == null) return remaining;
    const drafted = drafts.filter((draft) => draft.cosmeticId === cosmeticId).length;
    return Math.max(remaining - drafted, 0);
  };

  const maxScale = stickerMaxScale(space?.settings as Record<string, unknown> | undefined);

  /**
   * A sticker reaches the image by being dragged onto it, and by nothing else.
   *
   * Pressing one creates no draft. The draft comes into existence on the first
   * pointer move that lands inside the media box, positioned under the cursor;
   * a press that never gets there — a plain click, or a drag released outside —
   * leaves the image untouched. Creating it on pointer-down put a sticker in the
   * middle of someone's work before they had chosen anywhere and then teleported
   * it, which is the thing being fixed rather than a detail of when it renders.
   */
  const grab = (cosmeticId: number) => (event: React.PointerEvent) => {
    // No pickup while a drag is already in flight. The layer holds one gesture,
    // so the sticker this created would be dropped on the image and then never
    // follow anything — placed, stationary, with no cue that it went wrong.
    //
    // Gated on a live gesture rather than on `event.isPrimary`, which looks
    // equivalent and is not: a mouse is primary no matter how many touches are
    // down, so a trackpad pickup during a touch drag walked straight past it —
    // and a palm resting on a tablet makes the dragging finger non-primary, so
    // it silently dropped pickups that were perfectly fine.
    if (useStickerPlacementDraftStore.getState().interaction) return;

    event.preventDefault();
    endGrab.current?.();
    setDragging(cosmeticId);
    const { pointerId } = event;

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const at = pointerOverSurface(move.clientX, move.clientY);
      if (!at) return;
      begin(cosmeticId, at, maxScale);
      // Handing the drag to the layer, which owns it from here — along with the
      // pointer holding it, so the layer arms against this finger rather than
      // whichever one moves next. Armed only once the sticker exists on the
      // image, so there is never a live move gesture with nothing to move.
      setInteraction('move', pointerId);
      teardown();
    };

    const teardown = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', teardown);
      window.removeEventListener('pointercancel', teardown);
      endGrab.current = null;
      setDragging(null);
    };

    endGrab.current = teardown;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', teardown);
    window.addEventListener('pointercancel', teardown);
  };

  const price = space?.price ?? 0;
  // Says the panel can be got out of the way, and that more than one is allowed,
  // only once there is something that would survive it. Before that both are
  // instructions about nothing.
  const instruction = drafts.length
    ? 'Drag out as many as you like, then buy the ones you want. Closing this panel leaves them on the image.'
    : 'Drag a sticker onto the image.';

  return (
    // Measured as the obstacle the buy button avoids, and deliberately measured
    // at full width rather than at the visible panel's `max-w-xl`: this root
    // spans the viewport and takes the clicks across all of it.
    <div ref={trayRef} className="fixed inset-x-0 bottom-0 z-30 flex justify-center p-3">
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-gray-3 bg-white shadow-lg dark:border-dark-4 dark:bg-dark-7">
        <div className="flex items-start gap-2 border-b border-gray-3 px-3 py-2 dark:border-dark-4">
          <div className="flex-1">
            <Text size="sm" fw={600}>
              {instruction}
            </Text>
            <Text size="xs" c="dimmed">
              {price} Buzz + one use
              {space?.mode === 'review' &&
                ' · this creator reviews placements, so only you will see it until they approve. If they decline, part of what you paid stays with them.'}
            </Text>
          </div>
          <CloseButton
            onClick={closeTray}
            aria-label={drafts.length ? 'Close the sticker panel' : 'Stop placing a sticker'}
          />
        </div>

        {topUp ? (
          <div className="p-3">
            <StickerTopUp
              sticker={topUp}
              onCancel={() => setTopUp(null)}
              // Returns to the row rather than starting a draft. Convenient as
              // that would be, it would put a sticker on the image with no drag
              // — the one thing `grab` above promises cannot happen — and a
              // purchase confirmation is not a placement gesture.
              onPurchased={() => setTopUp(null)}
            />
          </div>
        ) : (
          <ScrollArea.Autosize mah={120} type="auto" scrollbarSize={6}>
            <Group gap="xs" wrap="nowrap" p="xs">
              {isLoading && <Text size="sm">Loading your stickers…</Text>}
              {!isLoading && !sticker.length && (
                <Text size="sm" c="dimmed">
                  You don&apos;t own any stickers yet.
                </Text>
              )}
              {sticker.map((option) => {
                const remaining = balanceFor(option.id);
                const exhausted = remaining === 0;
                return (
                  <button
                    key={option.id}
                    type="button"
                    // An exhausted sticker opens the top-up instead of doing
                    // nothing. It stays a pointer-down like the others so the two
                    // outcomes of pressing a sticker share one gesture.
                    onPointerDown={exhausted ? () => setTopUp(option) : grab(option.id)}
                    className={clsx(
                      'flex shrink-0 cursor-grab flex-col items-center gap-1 rounded border p-2',
                      drafts.some((draft) => draft.cosmeticId === option.id) ||
                        dragging === option.id
                        ? 'border-blue-5'
                        : 'border-transparent',
                      exhausted && 'opacity-40'
                    )}
                    style={{ touchAction: 'none' }}
                  >
                    <EdgeImage
                      src={option.url}
                      alt={`:${option.slug}:`}
                      options={{ height: 96, anim: option.animated, optimized: true }}
                      style={{ height: 48, width: 'auto', pointerEvents: 'none' }}
                      draggable={false}
                    />
                    <Text size="10px">{remaining === null ? '∞' : remaining ?? '…'}</Text>
                  </button>
                );
              })}
            </Group>
          </ScrollArea.Autosize>
        )}
      </div>
    </div>
  );
}
