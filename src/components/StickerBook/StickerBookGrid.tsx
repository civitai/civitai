import { Text } from '@mantine/core';
import { IconSticker } from '@tabler/icons-react';
import { useMemo } from 'react';
import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import type { StickerBookSide } from '~/components/StickerBook/sticker-book.util';
import { constants } from '~/server/common/constants';
import type { RouterOutput } from '~/types/router';

type BookItems = RouterOutput['stickerBook']['get']['placed'];

/**
 * A card is a FIXED width and the row holds as many as fit — the feed's shape,
 * and Justin's call on review. Scaling cards to fill the row instead makes the
 * same image a different size on every viewport, and a sticker drawn as a
 * fraction of the artwork changes size with it.
 *
 * The height is that width at the 7:9 the profile sections use, so the grid
 * keeps its rhythm whatever each picture's own aspect is.
 */
/**
 * 🔴 320 and 16 are NOT free numbers — they are what makes `MasonryContainer`
 * usable here.
 *
 * That component snaps its width to an exact column multiple and centres it, and
 * it computes those steps in SCSS from hard-coded `$width: 320; $gap: 16`. There
 * is no prop path. At any other pair its container is the wrong size — at 280 it
 * leaves room for an eighth card, defeating the seven-column ceiling. Change
 * either number and the grid silently stops lining up with its own container.
 *
 * (It also sidesteps a bug rather than tripping it: `MasonryProvider` shadows
 * its own `gap` prop with a local `const gap = 16` when computing column count.
 * At 16 the shadow is a no-op.)
 */
const CARD_WIDTH = constants.cardSizes.image;
const CARD_HEIGHT = Math.round((CARD_WIDTH * 9) / 7);
const GRID_GAP = 16;

/**
 * The images in one section, drawn with the standard feed card.
 *
 * The card is the feed's own `ImagesCard`, and the rows arrive already in the
 * feed's shape — the service hydrates them through `getAllImages`, so what may
 * be shown is decided in the one place that decides it everywhere else. Nothing
 * here re-fetches: a second infinite query on a profile tab would be a feed
 * inside a feed.
 *
 * `ImagesProvider` is what makes the card's dialog carry the section as its
 * gallery, so paging through an image opens the next one in the book rather
 * than the global feed.
 */
export function StickerBookGrid({
  items,
  side,
  emptyMessage,
  wholeRowsOnly,
}: {
  items: BookItems;
  side: StickerBookSide;
  /**
   * Drawn when the viewer's own hides empty the section. The band's own check is
   * on the SERVER's row count, which does not know what this viewer hid — so
   * without this a viewer who hid every creator in a row gets a heading over
   * blank space.
   */
  emptyMessage?: string;
  /**
   * Draw only COMPLETE rows — the tab's preview, where a part-filled last row is
   * the reported defect ("what's the two blank image spots for?").
   *
   * 🔴 Trimming here rather than on the server is the only place it can be
   * correct: the column count is a property of the viewport, and the viewer's
   * own hides drop rows AFTER the server has counted. A fetch size cannot know
   * either. The remainder is not lost — "View all" is the whole section.
   *
   * Off for the drill-in page, which is the full list and must not hide its tail.
   */
  wholeRowsOnly?: boolean;
}) {
  const images = useMemo(() => items.map((item) => item.image), [items]);
  // The viewer's own hides, the same way every other grid applies them. Blocks
  // are enforced on the server; hides are a preference and live here.
  const { items: visible } = useApplyHiddenPreferences({ type: 'images', data: images });
  const survived = useMemo(() => {
    const ids = new Set(visible.map((image) => image.id));
    return items.filter((item) => ids.has(item.imageId));
  }, [items, visible]);

  // From the same container that lays the grid out, so the two cannot disagree.
  const { columnCount } = useMasonryContext();
  const shown = useMemo(() => {
    // `columnCount` is 0 until the container has measured, and a partial row is
    // better than an empty section while that resolves.
    if (!wholeRowsOnly || !columnCount || survived.length < columnCount) return survived;
    return survived.slice(0, Math.floor(survived.length / columnCount) * columnCount);
  }, [survived, columnCount, wholeRowsOnly]);

  if (!shown.length)
    return (
      <Text size="sm" c="dimmed">
        {/* Two different truths, and the section cannot tell them apart: it
            counts the SERVER's rows, which do not know what this viewer hid. An
            empty section says "nothing yet"; a section emptied by your own hides
            has plenty and none of it is for you. */}
        {items.length ? 'Everything here is from creators you have hidden.' : emptyMessage ?? null}
      </Text>
    );

  return (
    // 🔴 `hideStickerBadge`: the chip shares the reaction row and squeezes the
    // reaction counts until they clip. This page is about
    // stickers, so the count it was carrying says nothing new here — and
    // `revealStickers` is what draws them, so removing the chip removes no
    // control.
    <ImagesProvider images={visible} hideStickerBadge revealStickers>
      <div
        className="grid items-start"
        style={{ gridTemplateColumns: `repeat(auto-fill, ${CARD_WIDTH}px)`, gap: GRID_GAP }}
      >
        {shown.map((item) => (
          <div key={item.imageId} className="relative">
            <div style={{ width: CARD_WIDTH }}>
              <ImagesCard data={item.image} height={CARD_HEIGHT} />
            </div>
            <PlacedBy counterparts={item.counterparts} side={side} latestAt={item.latestAt} />
          </div>
        ))}
      </div>
    </ImagesProvider>
  );
}

/**
 * Who the other end of the placement was, over the bottom of the card.
 *
 * Both sections carry it, and only the verb changes: on the received side it is
 * who put a sticker on your work, on the placed side it is whose work you put
 * one on. Same shape either way — Justin's call on review, for visual
 * consistency between two rows that are the same act from opposite ends.
 */
function PlacedBy({
  counterparts,
  side,
  latestAt,
}: {
  counterparts: BookItems[number]['counterparts'];
  side: StickerBookSide;
  /** When the most recent sticker landed — Ellie's mock carried a time. */
  latestAt: Date | string | null;
}) {
  if (!counterparts.length) return null;

  const [first, ...rest] = counterparts;

  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-12 flex flex-col items-start gap-1">
      <span className="flex items-center gap-1 rounded bg-dark-9/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
        <IconSticker size={12} />
        {side === 'owner' ? 'Placed by' : 'Placed on'}
      </span>
      <div className="pointer-events-auto flex items-center gap-1 rounded bg-dark-9/70 px-1.5 py-0.5">
        {/* `Username` sets no colour, so it takes the theme's body text — a grey
            that reads as disabled next to the white label and the white "+N".
            Mantine's `Text` resolves its own colour rather than inheriting, so a
            colour on this wrapper would not reach it. */}
        <div className="[&_p]:!text-white">
          <UserAvatar userId={first.id} withUsername size="xs" textSize="xs" linkToProfile />
        </div>
        {rest.length > 0 && (
          <Text size="xs" c="white">
            +{rest.length}
          </Text>
        )}
        {latestAt && (
          <Text size="xs" c="white" className="opacity-70">
            <DaysFromNow date={new Date(latestAt)} />
          </Text>
        )}
      </div>
    </div>
  );
}
