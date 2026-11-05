import { useState } from 'react';
import { Button, Text } from '@mantine/core';
import { Popover } from '~/components/MantineOverlays';
import { IconCheck, IconSettingsFilled } from '@tabler/icons-react';
import clsx from 'clsx';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import { useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import classes from '~/components/HatTurf/HatTurfButton.module.css';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import { DEFAULT_SPOT, HatTurfPanelPopover } from '~/components/HatTurf/HatTurfPanel';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { useChosenHat, useHatStock, useJoin } from '~/components/HatTurf/useHatTurf';
import { useHatTurfAction } from '~/components/HatTurf/useHatTurfAction';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showInfoNotification } from '~/utils/notifications';
import type { ExperimentSurface } from '~/shared/constants/experiments.constants';

/** Hidden when signed out, when hats are switched off, or the image can't take a hat. */
export function HatTurfButton({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  const showHats = useHatTurfStore((state) => state.showHats);
  return feed && showHats ? <HatTurfButtonContent imageId={imageId} /> : null;
}

function HatTurfButtonContent({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  const user = useCurrentUser();
  const card = useHatTurfCard();
  const stock = useHatStock();
  const { cosmeticId } = useChosenHat();
  const [join, setJoin] = useState(false);
  const track = useHatTurfAction('feed-card');
  const setOptIn = useJoin(() => setJoin(false));

  // Until the viewer's stock is read, neither the hat nor the invite is known to be right.
  if (!feed || !card || !user || !stock || feed.hidden?.[imageId]) return null;
  const joined = stock.optedIn;
  // Closed images must still offer Join: a viewer who has not joined has no other way to opt in.
  if (joined && feed.open[imageId] === false) return null;

  const { draft, setDraft } = card;
  const placed =
    card.placed || feed.stickers[imageId]?.some((sticker) => sticker.userId === user.id);
  const available = stock?.available;
  const empty = joined && available === 0 && !placed;
  const label = !joined
    ? 'Join Hat Turf to place hats'
    : placed
    ? 'Your hat is placed here'
    : empty
    ? 'No hats left to place'
    : `Place a hat, ${available ?? 'some'} available`;

  const press = (event: React.MouseEvent) => {
    // The card is a link and this sits inside it.
    event.preventDefault();
    event.stopPropagation();
    if (!joined) return setJoin((open) => !open);
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
    if (!cosmeticId || draft) return;
    setDraft(DEFAULT_SPOT);
    track('feed_place_start', feed.event);
  };

  return (
    <div className={classes.wrap} data-testid="hat-turf-button">
      <HatButtonFace
        joined={joined}
        empty={empty}
        active={!!draft}
        placed={!!placed}
        aria-label={label}
        aria-pressed={!!draft}
        onClick={press}
      />
      <Popover
        opened={join}
        onChange={setJoin}
        withinPortal
        position="top-end"
        withArrow
        shadow="md"
      >
        <Popover.Target>
          <span className={classes.anchor} />
        </Popover.Target>
        <Popover.Dropdown p="sm" onClick={(event) => event.stopPropagation()}>
          <Text size="sm" fw={600} maw={190}>
            Join Hat Turf to place hats and score for your team.
          </Text>
          <Button
            mt="xs"
            size="xs"
            fullWidth
            color="yellow"
            loading={setOptIn.isPending}
            onClick={() => setOptIn.mutate({ event: feed.event, optedIn: true })}
          >
            Join Hat Turf
          </Button>
        </Popover.Dropdown>
      </Popover>
      {joined && <HatTurfGear imageId={imageId} surface="feed-card" placed={!!placed} />}
    </div>
  );
}

/** The gear on a hat button's top-right corner: opens the Hat Turf panel for the image. */
export function HatTurfGear({
  imageId,
  surface,
  placed,
}: {
  imageId: number;
  surface: ExperimentSurface;
  placed: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <HatTurfPanelPopover
      imageId={imageId}
      surface={surface}
      placed={placed}
      opened={open}
      onOpenChange={setOpen}
      position="top-end"
      target={
        <button
          type="button"
          className={classes.gear}
          aria-label="Hat Turf settings"
          aria-expanded={open}
          data-testid="hat-turf-gear"
          onClick={(event) => {
            // The card is a link and this sits inside it.
            event.preventDefault();
            event.stopPropagation();
            setOpen(!open);
          }}
        >
          <IconSettingsFilled size={11} />
        </button>
      }
    />
  );
}

/** The square hat button: the viewer's team colour while they can place, an outline until they join. */
export function HatButtonFace({
  joined,
  empty,
  active,
  placed,
  className,
  ...props
}: {
  joined: boolean;
  empty: boolean;
  active: boolean;
  placed: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement> & { 'data-testid'?: string }) {
  const feed = useTurfFeed();
  const teamColor = useTeamColor();
  return (
    <button
      type="button"
      {...props}
      className={clsx(
        classes.button,
        !joined && classes.invite,
        empty && classes.empty,
        active && classes.active,
        className
      )}
      style={joined && !empty && feed?.team ? { backgroundColor: teamColor(feed.team) } : undefined}
    >
      <HatIcon size={17} />
      {placed && (
        <span className={classes.tick} data-testid="hat-turf-placed">
          <IconCheck size={8} stroke={4} />
        </span>
      )}
    </button>
  );
}
