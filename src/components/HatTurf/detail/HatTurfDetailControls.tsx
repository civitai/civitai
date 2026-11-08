import { useState } from 'react';
import clsx from 'clsx';
import { Button } from '@mantine/core';
import { Popover } from '~/components/MantineOverlays';
import { useLocalStorage } from '@mantine/hooks';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import { HatTurfBadge } from '~/components/HatTurf/HatTurfBadge';
import buttonClasses from '~/components/HatTurf/HatTurfButton.module.css';
import { HatButtonFace, HatTurfGear } from '~/components/HatTurf/HatTurfButton';
import { useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import { DEFAULT_SPOT, HatTurfPanelPopover } from '~/components/HatTurf/HatTurfPanel';
import { TeamHat } from '~/components/HatTurf/TeamHat';
import { useTurfFeed, useTurfSummary } from '~/components/HatTurf/TurfSummaryProvider';
import classes from '~/components/HatTurf/detail/HatTurfDetailControls.module.css';
import { useChosenHat, useHatStock, useJoin } from '~/components/HatTurf/useHatTurf';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showInfoNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const INVITE_SNOOZE_MS = 24 * 60 * 60 * 1000;
const COVER_HATS = [
  { left: '8%', top: '30%', rotate: -15, color: 'var(--mantine-color-blue-4)' },
  { left: '32%', top: '8%', rotate: 10, color: 'var(--mantine-color-pink-4)' },
  { left: '60%', top: '34%', rotate: -8, color: 'var(--mantine-color-yellow-4)' },
  { left: '82%', top: '6%', rotate: 14, color: 'var(--mantine-color-green-4)' },
];

/** The hat button for the picture on screen. Nothing when Hat Turf is off or the picture is a contest entry. */
export function HatTurfDetailControls({
  imageId,
  large,
}: {
  imageId: number;
  /** A 36px circle, as the phone bottom bar's other buttons are. */
  large?: boolean;
}) {
  const feed = useTurfFeed();
  return feed && !feed.hidden?.[imageId] ? (
    <div
      className={clsx(classes.group, large && classes.large)}
      data-testid="hat-turf-detail-controls"
    >
      <HatButton imageId={imageId} />
    </div>
  ) : null;
}

function HatButton({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  const user = useCurrentUser();
  const card = useHatTurfCard();
  const stock = useHatStock();
  const { cosmeticId } = useChosenHat();
  const [dismissedAt, setDismissedAt] = useLocalStorage<number>({
    key: 'hat-turf-detail-invite-dismissed',
    defaultValue: 0,
    getInitialValueInEffect: true,
  });
  const [inviteOpen, setInviteOpen] = useState<boolean | undefined>(undefined);
  const join = useJoin();
  const placed = usePlacedHere(imageId);

  // Closed images still invite: an unjoined viewer has no other way to opt in.
  const closed = feed?.open[imageId] === false;
  if (!feed || !card || !user || (closed && stock?.optedIn !== false)) return null;
  const joined = stock?.optedIn === true;
  const snoozed = Date.now() - dismissedAt < INVITE_SNOOZE_MS;
  // Only someone who never joined is invited unprompted; a leaver rejoins from the button. Owner-off
  // users are refused on Join, so they are not invited either.
  const showInvite =
    inviteOpen ?? (!!stock && !joined && !stock.left && !stock.ownerOff && !snoozed);
  const empty = joined && stock?.available === 0 && !placed;

  const press = () => {
    if (!joined) return setInviteOpen(!showInvite);
    if (placed)
      return showInfoNotification({
        id: 'hat-turf-placed',
        message: 'Your hat is already on this image.',
      });
    if (empty)
      return showInfoNotification({
        id: 'hat-turf-empty',
        message: 'Out of hats. You get more as the event goes on.',
      });
    if (!cosmeticId) return;
    card.setDraft(card.draft ?? DEFAULT_SPOT);
  };

  return (
    <Popover
      opened={showInvite}
      onChange={(open) => {
        if (!open) setInviteOpen(false);
      }}
      closeOnClickOutside={false}
      position="top"
      width={236}
      withArrow
      withinPortal
      shadow="md"
    >
      <Popover.Target>
        <span className={buttonClasses.wrap}>
          <HatButtonFace
            joined={joined}
            empty={empty}
            active={!!card.draft}
            placed={placed}
            stock={stock}
            className={classes.hat}
            data-testid="hat-turf-detail-hat"
            aria-label={joined ? 'Place your cap' : 'Join Hat Turf'}
            aria-pressed={joined ? !!card.draft : undefined}
            onClick={press}
          />
          {joined && <HatTurfGear imageId={imageId} surface="image-detail" placed={placed} />}
        </span>
      </Popover.Target>
      <Popover.Dropdown className={classes.invite} data-testid="hat-turf-detail-invite">
        <div className={classes.cover} aria-hidden="true">
          {COVER_HATS.map((hat) => (
            <span
              key={hat.left}
              className={classes.coverHat}
              style={{ left: hat.left, top: hat.top, transform: `rotate(${hat.rotate}deg)` }}
            >
              <TeamHat color={hat.color} size={22} />
            </span>
          ))}
        </div>
        <div className={classes.inviteBody}>
          <b className={classes.inviteTitle}>The birthday event is on: join Hat Turf</b>
          <div className={classes.inviteActions}>
            <Button
              size="compact-sm"
              color="yellow"
              radius="xl"
              loading={join.isPending}
              onClick={() =>
                join.mutate(
                  { event: feed.event, optedIn: true },
                  { onSuccess: () => setInviteOpen(false) }
                )
              }
            >
              Join
            </Button>
            <button
              type="button"
              className={classes.notNow}
              onClick={() => {
                setDismissedAt(Date.now());
                setInviteOpen(false);
              }}
            >
              Not now
            </button>
          </div>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

/** The feed's badge, in the picture's action row after Tip; a tap opens the Hat Turf panel. */
export function HatTurfDetailBadge({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  const summary = useTurfSummary(imageId);
  const user = useCurrentUser();
  const placed = usePlacedHere(imageId);
  const [open, setOpen] = useState(false);
  // A signed-out viewer keeps the badge: its card is their only invite (sign in, then join). A
  // signed-in viewer who has not joined is invited by the hat button instead.
  if (!feed || feed.hidden?.[imageId] || (user && !feed.joined)) return null;

  return (
    <HatTurfPanelPopover
      imageId={imageId}
      surface="image-detail"
      placed={placed}
      opened={open}
      onOpenChange={setOpen}
      target={
        <button
          type="button"
          className={classes.badgeButton}
          data-testid="hat-turf-detail-badge"
          aria-label="Hat Turf standings"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {summary ? (
            <HatTurfBadge imageId={imageId} className={classes.rowBadge} />
          ) : (
            <span className={classes.badgeEmpty}>
              <HatIcon size={18} />
            </span>
          )}
        </button>
      }
    />
  );
}

/** The viewer's hat is on this image: placed just now, or found by the image's own sticker read. */
function usePlacedHere(imageId: number) {
  const feed = useTurfFeed();
  const user = useCurrentUser();
  const card = useHatTurfCard();
  // Same query as the layer's, so one request. The feed's sticker list is capped at 5 per image.
  const { data: image } = trpc.hatTurf.getImageStickers.useQuery(
    { event: feed?.event ?? '', imageId },
    { enabled: !!feed?.joined && !!user, staleTime: 30_000 }
  );
  return !!card?.placed || !!image?.mine;
}
