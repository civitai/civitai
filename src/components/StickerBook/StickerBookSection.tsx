import { Badge, Text, Title } from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { CardStickerOverlay } from '~/components/Sticker/CardStickerOverlay';
import { StickerPlacementBatchProvider } from '~/components/Sticker/StickerPlacementBatchProvider';
import type { RouterOutput } from '~/types/router';

type BookSection = RouterOutput['stickerBook']['get']['placed'];
type BookItem = BookSection[number];

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
  countLabel,
  nameLabel,
}: {
  title: string;
  emptyMessage: string;
  items: BookSection;
  /** What the badge counts on a card carrying more than one. */
  countLabel: (count: number) => string;
  /** How the people on the other end of the placement are described. */
  nameLabel: (names: string[]) => string | null;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <Title order={3}>{title}</Title>
        {!!items.length && (
          <Text size="sm" c="dimmed">
            {items.length}
          </Text>
        )}
      </div>

      {!items.length ? (
        <Text size="sm" c="dimmed">
          {emptyMessage}
        </Text>
      ) : (
        <StickerPlacementBatchProvider imageIds={items.map((item) => item.imageId)}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {items.map((item) => (
              <StickerBookCard
                key={item.imageId}
                item={item}
                countLabel={countLabel}
                nameLabel={nameLabel}
              />
            ))}
          </div>
        </StickerPlacementBatchProvider>
      )}
    </section>
  );
}

function StickerBookCard({
  item,
  countLabel,
  nameLabel,
}: {
  item: BookItem;
  countLabel: (count: number) => string;
  nameLabel: (names: string[]) => string | null;
}) {
  const { image } = item;
  const names = item.counterparts.map((user) => user.username);
  const caption = nameLabel(names);

  return (
    <div className="overflow-hidden rounded-lg border border-gray-3 bg-white dark:border-dark-4 dark:bg-dark-7">
      <Link href={`/images/${item.imageId}`} className="relative block">
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
        <CardStickerOverlay imageId={item.imageId} />
        {item.placementCount > 1 && (
          <Badge size="sm" variant="filled" color="dark" className="absolute left-2 top-2">
            {countLabel(item.placementCount)}
          </Badge>
        )}
      </Link>
      {caption && (
        <Text size="xs" c="dimmed" className="truncate px-2 py-1.5">
          {caption}
        </Text>
      )}
    </div>
  );
}
