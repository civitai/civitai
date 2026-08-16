import { Button, CloseButton, Group, ScrollArea, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconPlus, IconSticker } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { StickerShopPanel } from '~/components/Sticker/StickerShopPanel';
import { useStickerDragOut } from '~/components/Sticker/use-sticker-drag-out';
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
  const [shopping, setShopping] = useState(false);
  const trayRef = useRef<HTMLDivElement>(null);

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
    if (!showing) {
      // The panel is state, not markup: without this it survives the tray being
      // put away and is still open on the next image opened.
      setShopping(false);
      return;
    }
    setTray(trayRef.current);
    return () => setTray(null);
  }, [showing, setTray]);

  const { space } = useImagePlacementSpace(targetImageId ?? undefined);
  const { data: balances } = trpc.cosmetic.getStickerBalances.useQuery(undefined, {
    enabled: !!currentUser && targetImageId != null,
  });
  // The creator's ceiling, not just the global one. Read before the early return
  // below, because the pickup gesture is a hook and cannot be conditional.
  const maxScale = stickerMaxScale(space?.settings as Record<string, unknown> | undefined);
  const { grab, dragging } = useStickerDragOut(maxScale);

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
      <div className="flex w-full max-w-xl flex-col">
        {/* Above the tray, not in place of it: the row of what you own is the
            thing you are shopping to add to, so it stays visible while you buy. */}
        {shopping && (
          <StickerShopPanel
            maxScale={maxScale}
            onClose={() => setShopping(false)}
            onTopUp={(sticker) => {
              setShopping(false);
              setTopUp(sticker);
            }}
          />
        )}
        <div className="overflow-hidden rounded-lg border border-gray-3 bg-white shadow-lg dark:border-dark-4 dark:bg-dark-7">
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
                {/* Owning nothing is the one state where the plus is not an
                  afterthought at the end of a row — it is the only thing to do,
                  so it gets said rather than left to be found. */}
                {!isLoading && !sticker.length && (
                  <div className="flex items-center gap-3 px-1 py-2">
                    <ThemeIcon size={40} radius="xl" variant="light" color="yellow">
                      <IconSticker size={22} />
                    </ThemeIcon>
                    <div className="flex flex-col items-start gap-1">
                      <Text size="sm" fw={500}>
                        No stickers yet
                      </Text>
                      <Button
                        size="compact-xs"
                        variant="light"
                        color="yellow"
                        leftSection={<IconPlus size={14} stroke={2.5} />}
                        onClick={() => {
                          setTopUp(null);
                          setShopping(true);
                        }}
                      >
                        Browse the sticker shop
                      </Button>
                    </div>
                  </div>
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

                {/* Takes the shape of a sticker slot, at the end of the row: the
                  way to get more is the next thing along from what you have,
                  rather than a control somewhere else on the panel. */}
                {!!sticker.length && (
                  <Tooltip label="Buy more stickers" withArrow>
                    <button
                      type="button"
                      onClick={() => {
                        setTopUp(null);
                        setShopping((open) => !open);
                      }}
                      aria-label="Buy more stickers"
                      aria-expanded={shopping}
                      className={clsx(
                        'flex h-[66px] w-14 shrink-0 flex-col items-center justify-center rounded border border-dashed',
                        shopping ? 'border-blue-5 text-blue-5' : 'border-gray-4 dark:border-dark-3'
                      )}
                    >
                      <IconPlus size={20} stroke={2.5} />
                    </button>
                  </Tooltip>
                )}
              </Group>
            </ScrollArea.Autosize>
          )}
        </div>
      </div>
    </div>
  );
}
