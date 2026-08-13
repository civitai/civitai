import { Anchor, Badge, Group, HoverCard, Skeleton, Text, Tooltip } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconEye, IconEyeOff, IconFlag, IconSticker, IconTrash } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { useForgetStickerPlacement } from '~/components/Sticker/placement.util';
import { ReportEntity } from '~/shared/utils/report-helpers';
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
  imageId,
  placerId,
  pending = false,
  children,
}: {
  placementId: number;
  /**
   * The image the sticker sits on. A sticker report is filed against the image
   * carrying the placement id — one reason, one queue — so the flag needs both.
   */
  imageId: number;
  /** Who placed it, so the flag can stay off the reporter's own sticker. Taken
   * from the listing rather than the detail query, which lands after the card
   * opens: keyed off that, the flag would appear on your own sticker and then
   * vanish. */
  placerId: number;
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
          <ReportPlacement placementId={placementId} imageId={imageId} placerId={placerId} />
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
          <>
            {/* Above the creator card rather than below it: the note is the
                thing the placer said, and the card is who said it. */}
            {data.comment && (
              <div className="border-b border-gray-3 px-3 py-2 dark:border-dark-4">
                {/* The note carries its own flag, so neither flow asks which
                    half is being reported. A fine sticker can carry an abusive
                    note, and the remedies differ — the owner can hide a note
                    without the sticker coming off. */}
                <Group gap={6} align="flex-start" wrap="nowrap">
                  <Text size="sm" className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                    {data.comment}
                  </Text>
                  <ReportPlacement
                    placementId={placementId}
                    imageId={imageId}
                    placerId={placerId}
                    target="comment"
                  />
                </Group>
                {data.commentHidden && (
                  <Text size="xs" c="dimmed" mt={4}>
                    Hidden — only you, the person who placed it, and moderators can see this.
                  </Text>
                )}
              </div>
            )}
            <SmartCreatorCard user={data.placer} withActions={false} withBorder={false} />
            {data.viewerIsOwner && (
              <OwnerControls
                placementId={placementId}
                hasComment={!!data.comment}
                commentHidden={data.commentHidden}
                isLive={data.status === 'approved'}
                removableAt={data.removableAt}
              />
            )}
          </>
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/**
 * Reporting one sticker, from that sticker.
 *
 * The report opens with the placement already set, which is the whole point.
 * The route this replaced was the image's report menu, where the reporter picked
 * from a list of the stickers on the image — several copies of one sticker are
 * indistinguishable there, so reporting one of them was a guess a moderator then
 * acted on. Starting here there is nothing to identify.
 *
 * Not offered on the reporter's own placement. There is a real "I regret this"
 * case and it is not a report; it belongs to whoever builds placer-side removal.
 */
function ReportPlacement({
  placementId,
  imageId,
  placerId,
  target = 'sticker',
}: {
  placementId: number;
  imageId: number;
  placerId: number;
  target?: 'sticker' | 'comment';
}) {
  const currentUser = useCurrentUser();

  if (!currentUser || currentUser.id === placerId) return null;

  const label = target === 'comment' ? 'Report this note' : 'Report this sticker';

  return (
    <Tooltip label={label} withArrow>
      <LegacyActionIcon
        color="gray"
        variant="subtle"
        size="sm"
        className="shrink-0"
        aria-label={label}
        onClick={() =>
          openReportModal({
            // Still an Image report carrying a placement id, not a new entity
            // type: the reason, the mod queue and the dedupe all already work
            // that way, and a second shape for the same complaint would give
            // moderators two queues for one sticker.
            entityType: ReportEntity.Image,
            entityId: imageId,
            reportKey: 'sticker-placement',
            placementId,
            placementTarget: target,
          })
        }
      >
        <IconFlag size={14} />
      </LegacyActionIcon>
    </Tooltip>
  );
}

/**
 * What the content owner can do about a sticker already on their image.
 *
 * The two controls are deliberately unequal. Hiding the note is unlocked — it
 * came free with the placement and is the owner's to refuse at any time, and
 * being able to put it back is what makes hiding a safe first move. Removing
 * the sticker waits a week from approval, because approval already paid the
 * owner and nothing is refunded: without the wait an owner could take the Buzz
 * and wipe the sticker before anyone saw it.
 *
 * Both refusals live on the server. The disabled button and its date are what
 * the card *says*, not what decides it.
 */
function OwnerControls({
  placementId,
  hasComment,
  commentHidden,
  isLive,
  removableAt,
}: {
  placementId: number;
  hasComment: boolean;
  commentHidden: boolean;
  isLive: boolean;
  removableAt: Date | string | null;
}) {
  const utils = trpc.useUtils();
  const forget = useForgetStickerPlacement();

  const setHidden = trpc.placement.setStickerCommentHidden.useMutation({
    onSuccess: () => utils.placement.getStickerPlacementDetail.invalidate({ placementId }),
    onError: (error) =>
      showErrorNotification({ title: "Couldn't change the note", error: new Error(error.message) }),
  });

  const remove = trpc.placement.actOnStickers.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Sticker removed.' });
      await forget(placementId);
    },
    onError: (error) =>
      showErrorNotification({ title: "Couldn't remove it", error: new Error(error.message) }),
  });

  if (!hasComment && !isLive) return null;

  const locked = !!removableAt;

  return (
    <Group
      gap="xs"
      px="sm"
      py={6}
      justify="flex-end"
      className="border-t border-gray-3 dark:border-dark-4"
    >
      {hasComment && (
        <Anchor
          component="button"
          type="button"
          size="xs"
          onClick={() => setHidden.mutate({ placementId, hidden: !commentHidden })}
        >
          <Group gap={4} wrap="nowrap">
            {commentHidden ? <IconEye size={14} /> : <IconEyeOff size={14} />}
            {commentHidden ? 'Show the note' : 'Hide the note'}
          </Group>
        </Anchor>
      )}

      {isLive && (
        <Tooltip
          withArrow
          multiline
          w={240}
          label={
            locked
              ? `Someone paid to place this, so it stays up for a week. You can remove it from ${formatDate(
                  removableAt as Date
                )}.`
              : 'Takes the sticker off your image. No Buzz moves.'
          }
        >
          {/* Wrapped, because a disabled control fires no pointer events and a
              tooltip on it never opens — which would leave the date explaining
              the button visible only to people who did not need it. */}
          <span>
            <Anchor
              component="button"
              type="button"
              size="xs"
              c={locked ? 'dimmed' : 'red'}
              disabled={locked}
              onClick={() =>
                openConfirmModal({
                  title: 'Remove this sticker',
                  children: (
                    <Text size="sm">
                      It comes off your image for everyone. The Buzz you were paid for it stays with
                      you, and nobody is notified.
                    </Text>
                  ),
                  labels: { confirm: 'Remove', cancel: 'Cancel' },
                  confirmProps: { color: 'red' },
                  onConfirm: () => remove.mutate({ placementIds: [placementId], action: 'remove' }),
                })
              }
            >
              <Group gap={4} wrap="nowrap">
                <IconTrash size={14} />
                Remove
              </Group>
            </Anchor>
          </span>
        </Tooltip>
      )}
    </Group>
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
  const forget = useForgetStickerPlacement();

  const remove = trpc.placement.removePlacement.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Placement removed.' });
      await forget(placementId);
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
