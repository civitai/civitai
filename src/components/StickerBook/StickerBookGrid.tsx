import { Text } from '@mantine/core';
import { IconSticker } from '@tabler/icons-react';
import { useMemo } from 'react';
import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { StickerBookSide } from '~/components/StickerBook/sticker-book.util';
import type { RouterOutput } from '~/types/router';

type BookItems = RouterOutput['stickerBook']['get']['placed'];

/** What a card is drawn at, matching the profile feeds it sits beside. */
const CARD_HEIGHT = 450;

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
    <ImagesProvider images={images}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((item) => (
          <div key={item.imageId} className="relative">
            <ImagesCard data={item.image} height={CARD_HEIGHT} />
            <PlacedBy counterparts={item.counterparts} side={side} />
          </div>
        ))}
      </div>
    </ImagesProvider>
  );
}

/**
 * Who put the sticker there, over the bottom of the card.
 *
 * Only on the received side. On the placed side the person on the other end is
 * the image's own creator, which the card already names — a second attribution
 * saying the same thing reads as a claim about the sticker.
 */
function PlacedBy({
  counterparts,
  side,
}: {
  counterparts: BookItems[number]['counterparts'];
  side: StickerBookSide;
}) {
  if (side !== 'owner' || !counterparts.length) return null;

  const [first, ...rest] = counterparts;

  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-12 flex flex-col items-start gap-1">
      <span className="flex items-center gap-1 rounded bg-dark-9/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
        <IconSticker size={12} />
        Placed by
      </span>
      <div className="pointer-events-auto flex items-center gap-1 rounded bg-dark-9/70 px-1.5 py-0.5">
        <UserAvatar userId={first.id} withUsername size="xs" textSize="xs" linkToProfile />
        {rest.length > 0 && (
          <Text size="xs" c="white">
            +{rest.length}
          </Text>
        )}
      </div>
    </div>
  );
}
