import { Badge, Group, HoverCard, Skeleton, Text, UnstyledButton } from '@mantine/core';
import { IconSticker } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { daysFromNow, formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

// Loaded with the hover, not with the page. The creator card drags in profile
// cosmetics, live metrics and edge media, and every image detail page renders
// this overlay whether or not anyone hovers a sticker.
const SmartCreatorCard = dynamic(() =>
  import('~/components/CreatorCard/CreatorCard').then((m) => m.SmartCreatorCard)
);

/**
 * Wide enough that the creator card's top row never wraps.
 *
 * The card is fluid — it takes its width entirely from its parent — and the row
 * of rank badge, up to three stat badges and the cosmetic badge needs about
 * 385px before the badge drops to its own line. Elsewhere in the app it renders
 * at 426–450 (the image-detail sidebar, and the "profile width" the cosmetic
 * preview caps at), so this is the narrowest value that still looks like the
 * card people know.
 */
const HOVER_CARD_WIDTH = 400;

const A_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "3 hours ago" while it is still news, the date once it is history.
 *
 * A relative stamp stops being informative past a day — "2 months ago" tells you
 * less than the date does — and an absolute one is useless in the window where
 * people actually care, which is the hours right after someone placed it.
 */
const placedLabel = (placedAt: Date | string) => {
  const value = new Date(placedAt);
  return Date.now() - value.getTime() < A_DAY_MS ? daysFromNow(value) : formatDate(value);
};

/**
 * Who placed a sticker, when, and what the sticker is.
 *
 * The query runs on open rather than with the placements list. A feed page can
 * hold dozens of placed stickers and almost none of them get hovered, so joining
 * the placer onto the listing would pay for every card nobody looks at.
 */
export function StickerPlacementHoverCard({
  placementId,
  pending = false,
  children,
}: {
  placementId: number;
  pending?: boolean;
  children: ReactElement;
}) {
  const [opened, setOpened] = useState(false);

  const { data, isLoading } = trpc.placement.getStickerPlacementDetail.useQuery(
    { placementId },
    { enabled: opened, staleTime: 5 * 60_000 }
  );

  const stickerCreator = data?.sticker?.creator;

  return (
    <HoverCard
      width={HOVER_CARD_WIDTH}
      shadow="sm"
      withArrow
      withinPortal
      openDelay={300}
      position="bottom"
      // Closer than the default, so the card reads as belonging to the sticker
      // rather than floating near it.
      offset={4}
      onOpen={() => setOpened(true)}
    >
      <HoverCard.Target>{children}</HoverCard.Target>
      {/* The creator card carries its own padding and fills the dropdown edge to
          edge. Its border is dropped rather than the dropdown's, so there is one
          outline instead of two nested ones a pixel apart. */}
      <HoverCard.Dropdown p={0}>
        <Group gap={6} px="sm" py={6} wrap="nowrap" justify="space-between">
          <Group gap={6} wrap="nowrap">
            <IconSticker size={14} className="text-yellow-6" />
            <Text size="xs" c="dimmed">
              {data ? `Placed ${placedLabel(data.placedAt)}` : 'Placed'}
            </Text>
          </Group>
          {pending && (
            <Badge size="xs" color="yellow" variant="light">
              Awaiting review
            </Badge>
          )}
        </Group>

        {/* A skeleton rather than a spinner: the card's size is known before its
            data is, so holding the shape stops the dropdown resizing under the
            cursor the moment it loads — which on a hover card can move the
            target out from under you. */}
        {isLoading || !data ? (
          <div className="p-3">
            <Skeleton height={92} radius="md" />
          </div>
        ) : (
          <>
            <SmartCreatorCard user={data.placer} withActions={false} withBorder={false} />

            {data.sticker && (
              <UnstyledButton
                component={Link}
                href={stickerCreator ? `/user/${stickerCreator.username}/shop` : '#'}
                // The row is the link, not just the names in it — a two-word
                // target inside a 400px card is a needle to hit with a mouse
                // that is already hovering something else.
                className="block w-full border-t border-gray-3 px-3 py-2 hover:bg-gray-1 dark:border-dark-4 dark:hover:bg-dark-6"
              >
                <Text size="xs" lineClamp={1}>
                  <Text span fw={600}>
                    {data.sticker.name}
                  </Text>
                  {stickerCreator && (
                    <Text span c="dimmed">
                      {' '}
                      by {stickerCreator.username}
                    </Text>
                  )}
                </Text>
              </UnstyledButton>
            )}
          </>
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
