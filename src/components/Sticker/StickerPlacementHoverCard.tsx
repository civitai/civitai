import { HoverCard, Loader, Stack, Text } from '@mantine/core';
import dynamic from 'next/dynamic';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

// Loaded with the hover, not with the page. The creator card drags in profile
// cosmetics, live metrics and edge media, and every image detail page renders
// this overlay whether or not anyone hovers a sticker.
const SmartCreatorCard = dynamic(() =>
  import('~/components/CreatorCard/CreatorCard').then((m) => m.SmartCreatorCard)
);

/**
 * Who placed a sticker, and when.
 *
 * The query runs on open rather than with the placements list. A feed page can
 * hold dozens of placed stickers and almost none of them get hovered, so joining
 * the placer onto the listing would pay for every card nobody looks at.
 */
export function StickerPlacementHoverCard({
  placementId,
  children,
}: {
  placementId: number;
  children: ReactElement;
}) {
  const [opened, setOpened] = useState(false);

  const { data, isLoading } = trpc.placement.getStickerPlacementDetail.useQuery(
    { placementId },
    { enabled: opened, staleTime: 5 * 60_000 }
  );

  return (
    <HoverCard
      width={330}
      shadow="sm"
      withArrow
      withinPortal
      openDelay={300}
      position="bottom"
      onOpen={() => setOpened(true)}
    >
      <HoverCard.Target>{children}</HoverCard.Target>
      <HoverCard.Dropdown p="xs">
        {isLoading || !data ? (
          <Loader size="sm" />
        ) : (
          <Stack gap={6}>
            <Text size="xs" c="dimmed">
              Placed {formatDate(data.placedAt)}
            </Text>
            <SmartCreatorCard user={data.placer} withActions={false} />
          </Stack>
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
