import { Loader, Text } from '@mantine/core';
import { IconSticker } from '@tabler/icons-react';
import { useMemo } from 'react';
import { useQueryImages } from '~/components/Image/image.utils';
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
 * 🔴 THE SERVER SENDS IDS, NOT IMAGES, AND THAT IS THE POINT. The book's own
 * query answers "which images, in what order, and who was on the other end";
 * everything about whether an image may be *shown* — the browsing level, the
 * domain ceiling, the publish and moderation rules, the viewer's hidden users
 * and tags — belongs to `image.getInfinite`, which every other feed on the site
 * already goes through. A second, hand-written copy of those rules here is a
 * copy that drifts, and the half that drifts is the half that leaks.
 *
 * The cost is one extra request per section and losing control of the order,
 * which is why the ids are re-sorted below.
 */
export function StickerBookGrid({ items, side }: { items: BookItems; side: StickerBookSide }) {
  const ids = useMemo(() => items.map((item) => item.imageId), [items]);
  const { images, isLoading } = useQueryImages({ ids }, { enabled: ids.length > 0 });

  const ordered = useMemo(() => {
    const byId = new Map(images.map((image) => [image.id, image]));
    // The book's order, not the feed's: `getInfinite` sorts by its own rules, and
    // these sections mean "most recently stickered". An image the feed withheld
    // is simply absent, which is the same answer as it not being in the book.
    return ids.flatMap((id) => {
      const image = byId.get(id);
      return image ? [image] : [];
    });
  }, [ids, images]);

  const counterpartsById = useMemo(
    () => new Map(items.map((item) => [item.imageId, item.counterparts])),
    [items]
  );

  if (isLoading && !ordered.length)
    return (
      <div className="flex justify-center py-8">
        <Loader />
      </div>
    );

  if (!ordered.length) return null;

  return (
    <ImagesProvider images={ordered}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {ordered.map((image) => (
          <div key={image.id} className="relative">
            <ImagesCard data={image} height={CARD_HEIGHT} />
            <PlacedBy counterparts={counterpartsById.get(image.id) ?? []} side={side} />
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
