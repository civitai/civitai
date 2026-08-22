import { Button, CloseButton, Group, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconPlus, IconSticker } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { Countdown } from '~/components/Countdown/Countdown';
import { freeOfferFor, preCommitFreeReason, trayNotes } from '~/components/Sticker/free-offer';
import { StickerShopPanel } from '~/components/Sticker/StickerShopPanel';
import { StickerShopTile } from '~/components/Sticker/StickerShopTile';
import { useStickerDragOut } from '~/components/Sticker/use-sticker-drag-out';
import {
  useFreePlacementStanding,
  useImagePlacementSpace,
} from '~/components/Sticker/placement.util';
import { stickerMaxScale } from '~/shared/utils/sticker-placement';
import { remainingStickerUses, useOwnedSticker } from '~/components/Sticker/sticker.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';
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
/**
 * A tile is the 48px sticker image plus its uses label and padding. Named because
 * the tray's height cap is derived from it — a tile that grows without this
 * changing would silently show a fraction of the second row.
 */
const STICKER_TILE_HEIGHT = 78;
/** Mantine `xs`, used as both the gap between tiles and the row's padding. */
const STICKER_TILE_GAP = 10;

/** The height that shows exactly `rows` rows of tiles and clips the rest. */
const trayRowsHeight = (rows: number) =>
  rows * STICKER_TILE_HEIGHT + (rows - 1) * STICKER_TILE_GAP + 2 * STICKER_TILE_GAP;

export function StickerPlacementTray({ imageId }: { imageId: number }) {
  const currentUser = useCurrentUser();
  const { sticker, isLoading } = useOwnedSticker();
  const [shopping, setShopping] = useState(false);
  const trayRef = useRef<HTMLDivElement>(null);

  const targetImageId = useStickerPlacementDraftStore((state) => state.targetImageId);
  const trayOpen = useStickerPlacementDraftStore((state) => state.trayOpen);
  const drafts = useStickerPlacementDraftStore((state) => state.drafts);
  const closeTray = useStickerPlacementDraftStore((state) => state.closeTray);
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
  // Same query key as the layer's, so this shares its cache rather than making a
  // second request. Here it only decides one clause of one sentence; the choice
  // itself is made on the draft, where the mode is also shown.
  const { standing } = useFreePlacementStanding(targetImageId ?? undefined);
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
  // Shared with the duplicate action, which asks the same question about the
  // same three states. It was this rule written out twice, which is the drift
  // the refill offer had already been split into two copies by.
  const balanceFor = (cosmeticId: number) => remainingStickerUses({ balances, drafts, cosmeticId });

  const price = space?.price ?? 0;
  // The same predicate the draft's own control uses, so the sentence here and
  // the button down there cannot disagree about what is on offer.
  const freeAvailable = !!freeOfferFor(space, standing);

  /**
   * Why free is off the table, said while the choice is still being made rather
   * than after the server has refused it.
   *
   * Every branch of that decision is in `free-offer.ts`, where a test can put
   * all four states to it — inline here, the guards that keep the sentence from
   * appearing on ordinary paid images are two `&&`s nothing can observe.
   */
  const freeUnavailableReason = preCommitFreeReason(freeAvailable, standing, space);
  // `Countdown` needs a Date; the query hands back whatever JSON carried.
  const resetsAt = standing?.resetsAt ? new Date(standing.resetsAt) : null;

  const notes = trayNotes({
    freeAvailable,
    price,
    review: space?.mode === 'review',
    reason: freeUnavailableReason,
    declineFee: space?.declineFee,
  });
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
        {shopping && <StickerShopPanel maxScale={maxScale} onClose={() => setShopping(false)} />}
        <div className="overflow-hidden rounded-lg border border-gray-3 bg-white shadow-lg dark:border-dark-4 dark:bg-dark-7">
          <div className="flex items-start gap-2 border-b border-gray-3 px-3 py-2 dark:border-dark-4">
            <div className="flex-1">
              <Text size="sm" fw={600}>
                {instruction}
              </Text>
              {/* One short line each, with an icon, rather than one sentence
                  spanning the panel. Which lines exist and what they say is
                  decided in `free-offer.ts`, where every branch is covered;
                  this only draws them. */}
              <div className="mt-0.5 flex flex-col gap-0.5">
                {notes.map((note) => (
                  <div key={note.id} className="flex items-start gap-1.5">
                    {note.tone === 'warn' ? (
                      <IconAlertTriangle
                        size={13}
                        className="mt-0.5 shrink-0 text-yellow-6"
                        aria-hidden
                      />
                    ) : (
                      <IconInfoCircle
                        size={13}
                        className="mt-0.5 shrink-0 opacity-60"
                        aria-hidden
                      />
                    )}
                    <Text size="xs" c={note.tone === 'warn' ? 'yellow.6' : 'dimmed'}>
                      {note.text}
                      {/* The spent-allowance line is the one note whose answer
                          keeps changing while the panel is open, so it says WHEN
                          rather than a phrase that ages: a live countdown to the
                          reset instead of "it comes back tomorrow" still sitting
                          there at 11:59. Only on that note, and only when the
                          server told us when. */}
                      {note.id === 'reason' && standing && standing.remaining <= 0 && resetsAt && (
                        <>
                          {' Next free placement: '}
                          <Countdown endTime={resetsAt} format="short" />
                        </>
                      )}
                    </Text>
                  </div>
                ))}
              </div>
            </div>
            <CloseButton
              onClick={closeTray}
              aria-label={drafts.length ? 'Close the sticker panel' : 'Stop placing a sticker'}
            />
          </div>

          {/* Native overflow, not `ScrollArea.Autosize`. Autosize wraps its child in a
              `display:flex; overflow:auto` box whose `flex:1` inner box keeps the default
              `min-width:auto`, so it refuses to shrink to the panel: the scroll viewport
              came out wider than the visible panel, putting the track's end and the last
              sticker outside the clip. */}
          <div
            className="overflow-y-auto"
            style={{ maxHeight: trayRowsHeight(2), scrollbarWidth: 'thin' }}
          >
            <Group gap={STICKER_TILE_GAP} p={STICKER_TILE_GAP}>
              {isLoading && <Text size="sm">Loading your stickers…</Text>}

              {/* Ahead of the stickers, so it stays put as the row grows. */}
              {!isLoading && !!sticker.length && (
                <StickerShopTile open={shopping} onClick={() => setShopping((open) => !open)} />
              )}

              {/* Owning nothing is the one state where the tile is not enough —
                  there is nothing beside it to explain it, so it gets said. */}
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
                    // 🔴 NO GATE IS STORED HERE, DELIBERATELY. An exhausted
                    // sticker drags out like any other and the draft layer
                    // decides what it owes, because that answer changes as other
                    // drafts come and go: freezing "you must buy this" onto the
                    // draft is what left a sticker asking to be bought for a use
                    // another draft had just handed back.
                    onPointerDown={grab(option.id)}
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
          </div>
        </div>
      </div>
    </div>
  );
}
