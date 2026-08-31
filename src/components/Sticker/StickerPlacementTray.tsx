import { Button, CloseButton, Group, Select, Text, TextInput, ThemeIcon } from '@mantine/core';
import {
  IconAlertTriangle,
  IconInfoCircle,
  IconPlus,
  IconSearch,
  IconSticker,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
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
 * The height of one tile, SET on the tile rather than measured from it. The
 * tray's two-row cap is derived from this number, so a tile free to grow past it
 * would leave the second row showing a sliver with nothing to catch it.
 */
const STICKER_TILE_HEIGHT = 78;
/** Mantine `xs`, used as both the gap between tiles and the row's padding. */
const STICKER_TILE_GAP = 10;

type StickerTraySort = 'used' | 'obtained';

/**
 * A collection worth searching. Below this the controls are two widgets above
 * three stickers, which is the clutter the tray's notes were just trimmed of.
 */
const STICKER_SEARCH_THRESHOLD = 12;

/** The height that shows exactly `rows` rows of tiles and clips the rest. */
const trayRowsHeight = (rows: number) =>
  rows * STICKER_TILE_HEIGHT + (rows - 1) * STICKER_TILE_GAP + 2 * STICKER_TILE_GAP;

export function StickerPlacementTray({ imageId }: { imageId: number }) {
  const currentUser = useCurrentUser();
  const { sticker, isLoading } = useOwnedSticker();
  const [shopping, setShopping] = useState(false);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<StickerTraySort>('used');
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
      // put away and is still open on the next image opened. The typed filter is
      // worse — it comes back showing 2 of 83 with nothing on screen saying why.
      setShopping(false);
      setSearch('');
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
  // 97.6% of sticker owners hold 12 or fewer and never see the sort control;
  // 73.4% hold one, where an order is a no-op. tRPC batching is off, so this is
  // its own round trip on the tray-open path — not worth taking for them.
  const { data: recentUse } = trpc.cosmetic.getStickerRecentUse.useQuery(undefined, {
    enabled: !!currentUser && targetImageId != null && sticker.length > 1,
    staleTime: 60_000,
  });
  // The creator's ceiling, not just the global one. Read before the early return
  // below, because the pickup gesture is a hook and cannot be conditional.
  const maxScale = stickerMaxScale(space?.settings as Record<string, unknown> | undefined);
  const { grab, dragging } = useStickerDragOut(maxScale);

  /**
   * What the tray actually draws: the collection filtered by what was typed, in
   * the chosen order.
   *
   * 🔴 THE SECONDARY SORT IS THE STABILITY, NOT A COMPARATOR BRANCH. `sticker`
   * arrives newest-obtained first, and `Array.prototype.sort` is stable, so two
   * stickers the placer has never used keep that order for free. Writing the
   * tie-break by hand would be a second copy of a rule already applied upstream.
   */
  const lastUsedAt = useMemo(
    () => new Map((recentUse ?? []).map((row) => [row.cosmeticId, row.lastUsedAt])),
    [recentUse]
  );
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matched = term
      ? sticker.filter((option) =>
          `${option.name ?? ''} ${option.slug ?? ''}`.toLowerCase().includes(term)
        )
      : sticker;

    if (sortBy === 'obtained') return matched;

    return [...matched].sort((a, b) => {
      const left = lastUsedAt.get(a.id);
      const right = lastUsedAt.get(b.id);
      if (left && right) return left < right ? 1 : left > right ? -1 : 0;
      // Used beats never-used; two never-used keep the obtained order they came in.
      if (left) return -1;
      if (right) return 1;
      return 0;
    });
  }, [sticker, search, sortBy, lastUsedAt]);

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
  // Says more than one is allowed only once there is a draft to say it about.
  // Before that it is an instruction about nothing.
  const instruction = drafts.length
    ? 'Drag out as many as you like, then pay to place the ones you want.'
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
          <div className="flex flex-wrap items-start gap-2 border-b border-gray-3 px-3 py-2 dark:border-dark-4">
            <div className="order-1 min-w-0 flex-1">
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
            {!isLoading && sticker.length > STICKER_SEARCH_THRESHOLD && (
              <div className="order-3 flex w-full shrink-0 items-center gap-2 sm:order-2 sm:w-auto">
                <TextInput
                  size="xs"
                  className="min-w-0 flex-1 sm:w-36 sm:flex-none"
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                  placeholder="Search"
                  aria-label="Search your stickers"
                  leftSection={<IconSearch size={14} />}
                />
                <Select
                  size="xs"
                  className="w-36 shrink-0 sm:w-40"
                  value={sortBy}
                  onChange={(value) => setSortBy(value === 'obtained' ? 'obtained' : 'used')}
                  data={[
                    { value: 'used', label: 'Recently used' },
                    { value: 'obtained', label: 'Recently acquired' },
                  ]}
                  aria-label="Sort your stickers"
                  allowDeselect={false}
                  // The panel clips its overflow, and this app defaults Popover to
                  // `withinPortal: false`, so the menu would open inside the clip.
                  comboboxProps={{ withinPortal: true }}
                />
              </div>
            )}
            <CloseButton
              className="order-2 sm:order-3"
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
              {visible.map((option) => {
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
                    style={{ touchAction: 'none', height: STICKER_TILE_HEIGHT }}
                    className={clsx(
                      'flex shrink-0 cursor-grab flex-col items-center justify-center gap-1 rounded border p-2',
                      drafts.some((draft) => draft.cosmeticId === option.id) ||
                        dragging === option.id
                        ? 'border-blue-5'
                        : 'border-transparent',
                      exhausted && 'opacity-40'
                    )}
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
              {!isLoading && !!sticker.length && !visible.length && (
                <Text size="sm" c="dimmed" px="xs">
                  No stickers match “{search.trim()}”.
                </Text>
              )}
            </Group>
          </div>
        </div>
      </div>
    </div>
  );
}
