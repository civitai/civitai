import { Button, CloseButton, Group, ScrollArea, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconPlus, IconSticker } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { freeOfferFor, preCommitFreeReason, trayNotes } from '~/components/Sticker/free-offer';
import { StickerShopPanel } from '~/components/Sticker/StickerShopPanel';
import { StickerShopTile } from '~/components/Sticker/StickerShopTile';
import { useStickerDragOut } from '~/components/Sticker/use-sticker-drag-out';
import {
  useFreePlacementStanding,
  useImagePlacementSpace,
} from '~/components/Sticker/placement.util';
import { stickerMaxScale } from '~/shared/utils/sticker-placement';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';
import { STICKER_OFFER_LIMIT } from '~/server/schema/cosmetic.schema';
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

  // Asked for every owned sticker rather than only the spent ones, because the
  // list of spent ones changes as drafts are laid down — keying the query on it
  // would refetch mid-arrangement, and the answer is the same either way.
  // Capped at what the schema accepts. Past it the whole query fails zod, and
  // the failure is invisible — `offers` stays undefined and the pack option
  // silently never appears for anyone with a large collection. Newest-obtained
  // first, which is the order the row is already in.
  const ownedIds = useMemo(
    () => sticker.slice(0, STICKER_OFFER_LIMIT).map((option) => option.id),
    [sticker]
  );
  const { data: offers } = trpc.cosmetic.getStickerOffers.useQuery(
    { ids: ownedIds },
    { enabled: !!currentUser && !!ownedIds.length, staleTime: 60_000 }
  );
  /**
   * What a spent sticker's draft may be refilled with. The listing is offered
   * only while it is genuinely on sale — a delisted or sold-out one would show a
   * price the purchase then refuses.
   *
   * `pricePerUse` falls back to the owned payload's copy so the single-use price
   * is there on the first frame, before the offers query lands.
   */
  const refillOffer = (cosmeticId: number, ownedPricePerUse?: number) => {
    const offer = offers?.find((entry) => entry.cosmeticId === cosmeticId);
    const listing = offer?.listing;

    return {
      refill: true,
      perUse: offer?.pricePerUse ?? ownedPricePerUse,
      ...(listing
        ? {
            pack: {
              shopItemId: listing.shopItemId,
              unitAmount: listing.unitAmount,
              acceptsBlue: listing.acceptsBlue,
              uses: listing.uses,
              viaShopUserId: listing.viaShopUserId ?? undefined,
            },
          }
        : {}),
      // `undefined` until the offers land, which shows no attribution rather
      // than crediting the wrong party while it is unknown.
      creatorUsername: offer ? offer.creatorUsername : undefined,
    };
  };

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

  const notes = trayNotes({
    freeAvailable,
    price,
    review: space?.mode === 'review',
    reason: freeUnavailableReason,
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

          <ScrollArea.Autosize mah={120} type="auto" scrollbarSize={6}>
            <Group gap="xs" wrap="nowrap" p="xs">
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
                    // An exhausted sticker drags out like any other. What is
                    // different is the draft it makes: it carries the price of
                    // one more use, and asks for that before it can be placed.
                    // Arranging it first is the point — the same argument as
                    // buying one from the shop, and the same gesture.
                    onPointerDown={grab(
                      option.id,
                      exhausted ? refillOffer(option.id, option.pricePerUse) : undefined
                    )}
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
        </div>
      </div>
    </div>
  );
}
