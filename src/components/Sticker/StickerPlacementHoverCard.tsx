import { Anchor, Badge, Group, HoverCard, Menu, Skeleton, Text, Tooltip } from '@mantine/core';
import { IconEye, IconEyeOff, IconFlag, IconMessage, IconSticker } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { HOVER_DELAY_MS } from '~/components/UserAvatar/hover-card.constants';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { daysFromNow, formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

// The only parts of this card that reach `placement.util`, and the placement
// draft store and free-offer helpers behind it. Deferring them takes that off
// the initial graph for every route that draws a sticker without rendering this
// card — the feed and article covers among them, though not the image detail
// page, which pulls the same chain through `ImageStickerOverlay` regardless.
//
// Both call sites gate on the viewer's role, which is what keeps the chunk
// unfetched rather than merely unrendered. `ssr: false` costs nothing here
// because neither can render for a viewer the server has not authorised, and
// neither is the card's `children` — deferring the card itself would blank the
// sticker artwork until the chunk arrived.
const OwnerRemove = dynamic(
  () => import('~/components/Sticker/StickerPlacementRemoveActions').then((m) => m.OwnerRemove),
  { ssr: false }
);

const ModeratorRemove = dynamic(
  () => import('~/components/Sticker/StickerPlacementRemoveActions').then((m) => m.ModeratorRemove),
  { ssr: false }
);

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
export const STICKER_HOVER_CARD_WIDTH = 400;

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
  pending = false,
  children,
}: {
  placementId: number;
  /**
   * The image the sticker sits on. A sticker report is filed against the image
   * carrying the placement id — one reason, one queue — so the flag needs both.
   */
  imageId: number;
  pending?: boolean;
  children: ReactElement;
}) {
  const currentUser = useCurrentUser();
  const [opened, setOpened] = useState(false);

  const { data, isLoading, error } = trpc.placement.getStickerPlacementDetail.useQuery(
    { placementId },
    { enabled: opened, staleTime: 5 * 60_000 }
  );

  // "Gone" and "could not ask" are different claims, and only the server can
  // tell them apart: the service throws a not-found for a placement that is no
  // longer live, and everything else here is a failed request. Batching runs
  // these with no retries and fails a whole cohort together, so treating any
  // error as a takedown would tell a viewer their sticker was removed because
  // an unrelated query in the same batch fell over.
  const gone = error?.data?.code === 'NOT_FOUND';

  // Both come from the service already resolved. Nothing here builds a URL from
  // a username, which is what produced a live link to `/user/null/shop`.
  const creatorName = data?.sticker?.creatorName ?? null;
  const shopHref = data?.sticker?.shopHref ?? null;

  return (
    <HoverCard
      width={STICKER_HOVER_CARD_WIDTH}
      shadow="sm"
      withArrow
      withinPortal
      // The delay the creator card and the sticker attribution card already use,
      // which is what a card that opens on a whole-object hover is tuned for. A
      // placed sticker is a small target inside a feed people swipe through, so
      // the pointer crosses several without stopping on any of them; 300ms was
      // short enough that a pass over the artwork opened the card.
      openDelay={HOVER_DELAY_MS}
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
        {/* A divider under it, so the line reads as the card's title rather than
            as the first of several stacked rows. Same header shape as the
            approve-with-note popover, which is the same object seen from the
            review queue. */}
        <Group
          gap={6}
          px="sm"
          py={6}
          wrap="nowrap"
          justify="space-between"
          className="border-b border-gray-3 dark:border-dark-4"
        >
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
          {/* The listing's answer until the card has its own, then retracted if
              they disagree. The prop is what lets the badge be right on the
              first frame; letting it stand afterwards is what had the card
              saying "Awaiting review" beside a confirmation that correctly
              treats the placement as live. */}
          {pending && (!data || data.status === 'pending') && (
            <Badge size="xs" color="yellow" variant="light">
              Awaiting review
            </Badge>
          )}
          {/* Waits for the card's own query rather than reading the listing's
              `hasComment`. The two disagree in both directions — the listing
              scopes the note to the placer and the owner where this query also
              hands it to moderators, and a listing fetched before the owner hid
              a note still says there is one — and the flag is a different
              element in each case, a button or a menu trigger. Rendered off the
              listing it would swap under the cursor as the card loads, so a
              click mid-swap lands on a node that no longer exists. */}
          {data && (
            <ReportPlacement
              placementId={placementId}
              imageId={imageId}
              placerId={data.placer.id}
              hasComment={!!data.comment}
            />
          )}
          {/* Two controls where a viewer holds both powers, not one that guesses
              which they meant. A takedown and an owner's removal differ in what
              they do to the placer's money — a takedown of a pending placement
              forfeits everything they paid, an owner's removal is held for the
              week they paid for and moves nothing — and the server decides which
              happened by the role exercised, not by the account. A moderator on
              their own image is still the owner, so they get both, each saying
              which it is. */}
          {data && (
            <>
              {/* The card's own query, never the listing. A listing is fetched
                  once and this app never refetches it on focus, so a party whose
                  placement was approved in another tab carries `isPending: true`
                  for as long as the page stays open — and that value would pick
                  the confirmation's sentence about the placer's money, right
                  before an irreversible click. */}
              {/* Gated here as well as inside the component: the guard within
                  decides whether it renders, but only this one decides whether
                  every hovering viewer downloads its chunk. */}
              {currentUser?.isModerator && (
                <ModeratorRemove
                  placementId={placementId}
                  pending={data.status === 'pending'}
                  free={data.free}
                />
              )}
              {data.viewerIsOwner && data.status === 'approved' && (
                <OwnerRemove
                  placementId={placementId}
                  removableAt={data.removableAt}
                  free={data.free}
                />
              )}
            </>
          )}
        </Group>

        {/* A skeleton rather than a spinner: the card's size is known before its
            data is, so holding the shape stops the dropdown resizing under the
            cursor the moment it loads — which on a hover card can move the
            target out from under you. */}
        {isLoading ? (
          <div className="p-3">
            <Skeleton height={92} radius="md" />
          </div>
        ) : !data ? (
          // A miss is the ordinary case, not an edge one: nothing refetches the
          // placements listing, so an overlay keeps drawing a sticker a
          // moderator took down minutes ago. Without this the card holds the
          // skeleton for as long as it is open — a spinner that reads as slow
          // rather than as gone, on a sticker that no longer exists.
          <div className="p-3">
            <Text size="sm" c="dimmed">
              {gone
                ? 'This sticker is no longer on the image.'
                : "We couldn't load this sticker just now."}
            </Text>
          </div>
        ) : (
          <>
            {/* Above the creator card rather than below it: the note is the
                thing the placer said, and the card is who said it. */}
            {data.comment && (
              <div className="border-b border-gray-3 px-3 py-2 dark:border-dark-4">
                {/* Its own surface, the same one the approve-with-note popover
                    quotes a note on. The note is someone else's words sitting
                    inside a card about the sticker, and unquoted it reads as the
                    card talking. */}
                <div className="rounded-md bg-gray-2 px-2 py-1.5 dark:bg-dark-5">
                  <Text size="sm" className="whitespace-pre-wrap break-words">
                    {data.comment}
                  </Text>
                </div>
                {data.commentHidden && (
                  <Text size="xs" c="dimmed" mt={4}>
                    Hidden — only you, the person who placed it, and moderators can see this.
                  </Text>
                )}
                {/* Under the note it acts on, not in a footer. Unlocked, unlike
                    removal: the note came free with the placement and is the
                    owner's to refuse at any time, and being able to put it back
                    is what makes hiding a safe first move. */}
                {data.viewerIsOwner && (
                  <HideNote placementId={placementId} commentHidden={data.commentHidden} />
                )}
              </div>
            )}
            <SmartCreatorCard user={data.placer} withActions={false} withBorder={false} />
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
  hasComment,
}: {
  placementId: number;
  imageId: number;
  placerId: number;
  /**
   * Whether a note the viewer can read hangs off this sticker, which decides
   * whether the flag has to ask which half. Taken from the listing rather than
   * the detail query so the control does not change shape under the cursor once
   * the card loads.
   */
  hasComment: boolean;
}) {
  const currentUser = useCurrentUser();

  if (!currentUser || currentUser.id === placerId) return null;

  const report = (placementTarget: 'sticker' | 'comment') =>
    openReportModal({
      // Still an Image report carrying a placement id, not a new entity type:
      // the reason, the mod queue and the dedupe all already work that way, and
      // a second shape for the same complaint would give moderators two queues
      // for one sticker.
      entityType: ReportEntity.Image,
      entityId: imageId,
      reportKey: 'sticker-placement',
      placementId,
      placementTarget,
    });

  const icon = <IconFlag size={14} />;

  // One flag either way. With a note there are two separately objectionable
  // things behind it — a fine sticker can carry an abusive note, and the
  // remedies differ, since the owner can hide a note without the sticker coming
  // off — so the flag asks which, rather than the card growing a second flag
  // that looks like the same control repeated.
  if (!hasComment)
    return (
      <Tooltip label="Report this sticker" withArrow>
        <LegacyActionIcon
          color="gray"
          variant="subtle"
          size="sm"
          className="shrink-0"
          aria-label="Report this sticker"
          onClick={() => report('sticker')}
        >
          {icon}
        </LegacyActionIcon>
      </Tooltip>
    );

  return (
    // Inline, so the menu is a DOM descendant of the card and not only a React
    // one. Either way the pointer may move onto an item without the hover card
    // closing — React derives enter/leave from the fiber tree, so a portalled
    // dropdown counts as inside it too — but the card still closes 150ms after
    // the pointer leaves it entirely, taking an open menu with it. Nothing here
    // changes that; keeping the dropdown inside just removes one way for the
    // two positioning contexts to disagree.
    <Menu withinPortal={false} position="bottom-end" withArrow>
      <Menu.Target>
        <LegacyActionIcon
          color="gray"
          variant="subtle"
          size="sm"
          className="shrink-0"
          aria-label="Report this sticker or its note"
        >
          {icon}
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>What are you reporting?</Menu.Label>
        <Menu.Item leftSection={<IconSticker size={14} />} onClick={() => report('sticker')}>
          The sticker itself
        </Menu.Item>
        <Menu.Item leftSection={<IconMessage size={14} />} onClick={() => report('comment')}>
          The note attached to it
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * The owner refusing a note without touching the sticker it came with.
 *
 * Reversible on purpose, and the reverse is the same control: an owner who hides
 * a note and changes their mind has to be able to put it back, or hiding is a
 * decision they will avoid making.
 */
function HideNote({ placementId, commentHidden }: { placementId: number; commentHidden: boolean }) {
  const utils = trpc.useUtils();

  const setHidden = trpc.placement.setStickerCommentHidden.useMutation({
    onSuccess: () => utils.placement.getStickerPlacementDetail.invalidate({ placementId }),
    onError: (error) =>
      showErrorNotification({ title: "Couldn't change the note", error: new Error(error.message) }),
  });

  return (
    <Anchor
      component="button"
      type="button"
      size="xs"
      mt={6}
      onClick={() => setHidden.mutate({ placementId, hidden: !commentHidden })}
    >
      <Group gap={4} wrap="nowrap">
        {commentHidden ? <IconEye size={14} /> : <IconEyeOff size={14} />}
        {commentHidden ? 'Show the note' : 'Hide the note'}
      </Group>
    </Anchor>
  );
}
