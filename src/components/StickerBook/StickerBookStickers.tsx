import { Anchor, Group, HoverCard, Skeleton, Text } from '@mantine/core';
import { IconSticker } from '@tabler/icons-react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useStickerAttribution } from '~/components/Sticker/sticker-attribution.util';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';

export type StickerBookSticker = { cosmeticId: number; remaining?: number | null };

/**
 * The stickers a creator owns, laid out the way the placement tray lays them
 * out rather than as a row per sticker.
 *
 * Justin's call, from the design session: the account-settings list shows four
 * before it needs scrolling, and most people will hold many more than four —
 * "the way that it's laid out in the placement is better, where they're just
 * side by side and you can see all of them". So: full width, wrapping, artwork
 * first, and the identity of each one behind a hover rather than spent on a
 * line of its own.
 *
 * The count is drawn only where it is allowed to be. It is not a toggle — it is
 * private to the owner in every setting — so `showQuantities` arrives already
 * decided by the server and this component never infers it from a missing
 * field.
 */
export function StickerBookStickers({
  stickers,
  showQuantities,
}: {
  stickers: StickerBookSticker[];
  showQuantities: boolean;
}) {
  const ids = stickers.map((sticker) => sticker.cosmeticId);
  const { sticker: artwork, isLoading } = useStickerCosmetics(ids);

  if (isLoading && !artwork.size)
    return (
      <Group gap="xs">
        {stickers.slice(0, 8).map((sticker) => (
          <Skeleton key={sticker.cosmeticId} height={96} width={96} radius="md" />
        ))}
      </Group>
    );

  return (
    <div className="flex flex-wrap gap-2">
      {stickers.map((sticker) => {
        const art = artwork.get(sticker.cosmeticId);
        // A sticker that has been taken down keeps its holding row but has no
        // artwork to draw, and a gap in the grid says less than nothing.
        if (!art) return null;

        return (
          <StickerTile
            key={sticker.cosmeticId}
            art={art}
            remaining={showQuantities ? sticker.remaining : undefined}
            showQuantity={showQuantities}
          />
        );
      })}
    </div>
  );
}

function StickerTile({
  art,
  remaining,
  showQuantity,
}: {
  art: { id: number; name: string; slug: string; url: string; animated?: boolean };
  remaining: number | null | undefined;
  showQuantity: boolean;
}) {
  // `null` is unlimited, a number is a count, and this component is only handed
  // either when the viewer may see them at all.
  const exhausted = showQuantity && remaining === 0;

  return (
    <HoverCard
      width={260}
      shadow="sm"
      withArrow
      // The grid sits inside a bordered card, and the app theme turns portalling
      // OFF for Popover globally; HoverCard has no theme entry but is stated
      // here so the dropdown cannot be clipped by the card either way.
      withinPortal
      openDelay={200}
      position="top"
    >
      <HoverCard.Target>
        <div
          className={`flex w-24 shrink-0 flex-col items-center gap-1 rounded border border-transparent p-1 ${
            exhausted ? 'opacity-40' : ''
          }`}
        >
          <EdgeImage
            src={art.url}
            alt={`:${art.slug}:`}
            options={{ height: 144, anim: art.animated, optimized: true }}
            style={{ height: 72, width: 'auto' }}
          />
          {showQuantity && (
            <Text size="xs" c="dimmed">
              {remaining === null ? '∞' : remaining ?? '…'}
            </Text>
          )}
        </div>
      </HoverCard.Target>
      <HoverCard.Dropdown p="xs">
        <StickerIdentity cosmeticId={art.id} fallbackName={art.name} slug={art.slug} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/**
 * Which sticker this is, and where it came from.
 *
 * Through the shared attribution hook rather than its own query, so the block
 * suppression that keeps a blocked creator's storefront out of reach applies
 * here too — a grid of someone's collection is exactly the surface where a
 * stranger's shop link would otherwise turn up unfiltered.
 */
function StickerIdentity({
  cosmeticId,
  fallbackName,
  slug,
}: {
  cosmeticId: number;
  fallbackName: string;
  slug: string;
}) {
  const { sticker, isLoading } = useStickerAttribution(cosmeticId);

  return (
    <div className="flex flex-col gap-1">
      <Group gap={6} wrap="nowrap">
        <IconSticker size={14} className="shrink-0 text-yellow-6" />
        <Text size="sm" fw={600} className="min-w-0 truncate">
          {sticker?.name ?? fallbackName}
        </Text>
      </Group>
      <Text size="xs" c="dimmed">
        :{slug}:
      </Text>
      {isLoading ? (
        <Skeleton height={10} width={120} />
      ) : (
        sticker?.creatorName && (
          <Text size="xs" c="dimmed">
            by{' '}
            {sticker.shopHref ? (
              <Anchor component={Link} href={sticker.shopHref} inherit>
                {sticker.creatorName}
              </Anchor>
            ) : (
              sticker.creatorName
            )}
          </Text>
        )
      )}
    </div>
  );
}
