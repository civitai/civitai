import { Anchor, Badge, Group, HoverCard, Skeleton, Text, Tooltip } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconSticker, IconTrash } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { daysFromNow, formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
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

  // Both come from the service already resolved. Nothing here builds a URL from
  // a username, which is what produced a live link to `/user/null/shop`.
  const creatorName = data?.sticker?.creatorName ?? null;
  const shopHref = data?.sticker?.shopHref ?? null;

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
          <Group gap={6} wrap="nowrap" className="min-w-0 flex-1">
            <IconSticker size={14} className="shrink-0 text-yellow-6" />

            {/* The names truncate and the timestamp does not. A long sticker name
                is still recognisable from its first few words, whereas half a
                timestamp is worth nothing — and "how long has this been here" is
                the question the line exists to answer. */}
            <Text size="xs" c="dimmed" className="min-w-0 truncate">
              Placed
              {data?.sticker && (
                <>
                  {' '}
                  {shopHref ? (
                    <Anchor component={Link} href={shopHref} underline="always" fw={600} inherit>
                      {data.sticker.name}
                    </Anchor>
                  ) : (
                    // A sticker whose creator's account is gone still has a name
                    // worth showing; it just has nowhere to link to.
                    <Text span fw={600} inherit>
                      {data.sticker.name}
                    </Text>
                  )}
                  {shopHref && (
                    <>
                      {' by '}
                      <Anchor component={Link} href={shopHref} underline="always" inherit>
                        {creatorName}
                      </Anchor>
                    </>
                  )}
                </>
              )}
            </Text>

            {data && (
              <Text size="xs" c="dimmed" className="shrink-0">
                · {placedLabel(data.placedAt)}
              </Text>
            )}
          </Group>
          {pending && (
            <Badge size="xs" color="yellow" variant="light">
              Awaiting review
            </Badge>
          )}
          <ModeratorRemove placementId={placementId} />
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
          <SmartCreatorCard user={data.placer} withActions={false} withBorder={false} />
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/**
 * A moderator taking a sticker off the content it was placed on, from the
 * sticker itself.
 *
 * The report queue is the route for something a user complained about; this is
 * the route for a moderator who is looking at the image and can see the problem.
 * Same mutation either way, so the two cannot drift into different rules about
 * what removal means.
 *
 * Nothing else happens: no refund, and nobody is notified (Justin, 2026-08-08).
 * The escrow on a live placement was paid to a content owner who did not choose
 * the sticker, and clawing it back would charge them for someone else's problem.
 *
 * Rendered for moderators only, which is convenience — `removePlacement` is a
 * `moderatorProcedure`, so the refusal is on the mutation and stays there.
 */
function ModeratorRemove({ placementId }: { placementId: number }) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();

  const remove = trpc.placement.removePlacement.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Placement removed.' });
      await utils.placement.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: "Couldn't remove it", error: new Error(error.message) }),
  });

  if (!currentUser?.isModerator) return null;

  return (
    <Tooltip label="Remove this sticker from the content" withArrow>
      <LegacyActionIcon
        color="red"
        variant="subtle"
        size="sm"
        className="shrink-0"
        aria-label="Remove placement"
        loading={remove.isPending}
        onClick={() =>
          openConfirmModal({
            title: 'Remove this placement',
            children: (
              <Text size="sm">
                The sticker comes off this content for everyone. No Buzz moves and nobody is
                notified.
              </Text>
            ),
            labels: { confirm: 'Remove', cancel: 'Cancel' },
            confirmProps: { color: 'red' },
            onConfirm: () => remove.mutate({ placementId }),
          })
        }
      >
        <IconTrash size={14} />
      </LegacyActionIcon>
    </Tooltip>
  );
}
