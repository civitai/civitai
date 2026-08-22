import { Text } from '@mantine/core';
import { IconSticker } from '@tabler/icons-react';
import { useMemo } from 'react';
import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import type { StickerBookSide } from '~/components/StickerBook/sticker-book.util';
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
const CARD_WIDTH = 280;
const CARD_HEIGHT = Math.round((CARD_WIDTH * 9) / 7);

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
export function StickerBookGrid({ items, side }: { items: BookItems; side: StickerBookSide }) {
  const images = useMemo(() => items.map((item) => item.image), [items]);

  if (!items.length) return null;

  return (
    // 🔴 `hideStickerBadge`: the chip shares the reaction row, and at a 280px
    // card it squeezes the reaction counts until they clip. This page is about
    // stickers, so the count it was carrying says nothing new here — but the
    // chip is also the reveal control, which is why the page header carries one.
    <ImagesProvider images={images} hideStickerBadge>
      <div
        className="grid items-start gap-3"
        style={{ gridTemplateColumns: `repeat(auto-fill, ${CARD_WIDTH}px)` }}
      >
        {items.map((item) => (
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
