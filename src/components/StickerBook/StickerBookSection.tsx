import { Anchor, Text, Title } from '@mantine/core';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { CardStickerOverlay } from '~/components/Sticker/CardStickerOverlay';
import { StickerPlacementCardBadge } from '~/components/Sticker/StickerPlacementCardBadge';
import { StickerPlacementBatchProvider } from '~/components/Sticker/StickerPlacementBatchProvider';
import type { RouterOutput } from '~/types/router';

type BookItems = RouterOutput['stickerBook']['get']['placed'];
type BookItem = BookItems[number];

/**
 * One row of the book: images carrying stickers, with the stickers drawn where
 * they were placed.
 *
 * The artwork comes from `CardStickerOverlay` and the batch provider rather than
 * from this page's own payload, which is the reuse that matters here: that
 * component owns the measurement of the drawn media box, the reveal preference,
 * the treatments, and the rule about whose pending placements a viewer may see.
 * Drawing from a second copy of the placement data would be a second answer to
 * all four.
 */
export function StickerBookSection({
  title,
  emptyMessage,
  items,
  viewAllHref,
}: {
  title: string;
  emptyMessage: string;
  items: BookItems;
  viewAllHref: string;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        {/* No number beside the heading. What this row holds is the page size,
            not the section's size, and printed next to "View all" it reads as a
            total — telling a creator with 400 stickered images that they have
            12. The real count is one aggregate away and not worth the query for
            a label. */}
        <Title order={3}>{title}</Title>
        {!!items.length && (
          <Anchor component={Link} href={viewAllHref} size="sm">
            View all
          </Anchor>
        )}
      </div>

      {!items.length ? (
        <Text size="sm" c="dimmed">
          {emptyMessage}
        </Text>
      ) : (
        <StickerBookGrid items={items} />
      )}
    </section>
  );
}

/** The grid itself, shared by the row on the tab and the page behind it. */
export function StickerBookGrid({ items }: { items: BookItems }) {
  if (!items.length) return null;

  return (
    <StickerPlacementBatchProvider imageIds={items.map((item) => item.imageId)}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {items.map((item) => (
          <StickerBookCard key={item.imageId} item={item} />
        ))}
      </div>
    </StickerPlacementBatchProvider>
  );
}

function StickerBookCard({ item }: { item: BookItem }) {
  const { image } = item;
  const names = item.counterparts.map((user) => user.username);
  // "+2" rather than a list: a card is one line wide and names are not bounded.
  const caption = names.length
    ? `by ${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ''}`
    : null;

  return (
    <div className="overflow-hidden rounded-lg border border-gray-3 bg-white dark:border-dark-4 dark:bg-dark-7">
      <div className="relative">
        {/* The routed dialog, like every other image grid: a sticker book is a
            place you browse, and navigating away from the tab to come back for
            the next one is not browsing. */}
        <RoutedDialogLink name="imageDetail" state={{ imageId: item.imageId }} className="block">
          {/* The card is the picture's own shape rather than a fixed square: the
              sticker's position is a fraction of the ARTWORK, and a crop moves
              the artwork inside the box. `CardStickerOverlay` measures the drawn
              rectangle and would be correct either way — this keeps a sticker
              placed near an edge from being cropped out of the card entirely. */}
          <EdgeMedia
            src={image.url}
            type={image.type}
            anim={false}
            name={image.name ?? image.id.toString()}
            alt={image.name ?? undefined}
            width={450}
            className="h-auto w-full"
          />
        </RoutedDialogLink>
        <CardStickerOverlay imageId={item.imageId} />
        {/* 🔴 THE COUNT IS ALSO THE REVEAL CONTROL, which is why it is this
            component and not a badge of our own. Stickers are off by default and
            the preference is site-wide and sticky, so a book drawn with a plain
            count chip is a page about stickers showing none of them, with
            nothing on it to turn them on. */}
        <StickerPlacementCardBadge imageId={item.imageId} className="absolute left-2 top-2" />
      </div>
      {caption && (
        <Text size="xs" c="dimmed" className="truncate px-2 py-1.5">
          {caption}
        </Text>
      )}
    </div>
  );
}
