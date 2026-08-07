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
export function StickerPlacementTray() {
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

  // A gesture in flight when the tray closes would leave window listeners behind
  // and could drop a sticker onto an image nobody is looking at any more.
  useEffect(() => () => endGrab.current?.(), []);

  const targetImageId = useStickerPlacementDraftStore((state) => state.targetImageId);
  const draft = useStickerPlacementDraftStore((state) => state.draft);
  const begin = useStickerPlacementDraftStore((state) => state.begin);
  const close = useStickerPlacementDraftStore((state) => state.close);
  const setInteraction = useStickerPlacementDraftStore((state) => state.setInteraction);

  const { space } = useImagePlacementSpace(targetImageId ?? undefined);
  const { data: balances } = trpc.cosmetic.getStickerBalances.useQuery(undefined, {
    enabled: !!currentUser && targetImageId != null,
  });

  if (targetImageId == null) return null;

  // `null` is unlimited and `undefined` is not loaded yet. Collapsing them
  // flashes "unlimited" on every open.
  const balanceFor = (cosmeticId: number) =>
    balances?.find((balance) => balance.cosmeticId === cosmeticId)?.remaining;

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
    event.preventDefault();
    endGrab.current?.();
    setDragging(cosmeticId);

    const onMove = (move: PointerEvent) => {
      const at = pointerOverSurface(move.clientX, move.clientY);
      if (!at) return;
      begin(cosmeticId, at, maxScale);
      // Handing the drag to the layer, which owns it from here. Armed only once
      // the sticker exists on the image, so there is never a live move gesture
      // with nothing to move.
      setInteraction('move');
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
  const instruction = draft
    ? 'Drag it where you want it, then buy it under the sticker.'
    : 'Drag a sticker onto the image.';

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex justify-center p-3">
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
          <CloseButton onClick={close} aria-label="Cancel placing a sticker" />
        </div>

        {topUp ? (
          <div className="p-3">
            <StickerTopUp
              sticker={topUp}
              onCancel={() => setTopUp(null)}
              // They pressed it to place it and hit the wall. Having paid, they
              // should not have to find it in the row again — the draft starts
              // centred on the image, ready to drag.
              // Only when nothing is already positioned. Replacing a draft the
              // placer has spent time placing, to hand them a centred one they
              // did not ask for, loses work silently — and they can still press
              // the sticker themselves.
              onPurchased={() => {
                if (!draft) begin(topUp.id, undefined, maxScale);
                setTopUp(null);
              }}
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
                      draft?.cosmeticId === option.id || dragging === option.id
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
