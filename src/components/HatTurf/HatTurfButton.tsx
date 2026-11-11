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
import { refillTimer, stockFill } from '~/components/HatTurf/hat-turf.utils';
import { useChosenHat, useHatStock, useJoin } from '~/components/HatTurf/useHatTurf';
import { useHatTurfAction } from '~/components/HatTurf/useHatTurfAction';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showInfoNotification } from '~/utils/notifications';
import type { ExperimentSurface } from '~/shared/constants/experiments.constants';

/** Hidden when signed out or the image can't take a hat. Show hats off keeps it: the game stays. */
export function HatTurfButton({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  return feed ? <HatTurfButtonContent imageId={imageId} /> : null;
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
        stock={stock}
        aria-label={label}
        aria-pressed={!!draft}
        className={classes.feed}
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
          <IconSettingsFilled size={12} />
        </button>
      }
    />
  );
}

type ButtonStock = {
  available: number;
  cap: number;
  nextAt: Date | null;
  perHour: number;
};

/**
 * The hat button, in the viewer's team colour while they can place and an outline until they join.
 * Once joined it is a dual gauge: the background fills with the hats they hold against their cap,
 * and a timer along its edge fills toward the next hat (a bar on the feed's rounded square, a ring
 * on the image page's circle).
 */
export function HatButtonFace({
  joined,
  empty,
  active,
  placed,
  stock,
  className,
  style,
  ...props
}: {
  joined: boolean;
  empty: boolean;
  active: boolean;
  placed: boolean;
  stock?: ButtonStock | null;
} & React.ButtonHTMLAttributes<HTMLButtonElement> & { 'data-testid'?: string }) {
  const feed = useTurfFeed();
  const teamColor = useTeamColor();
  const color = joined && feed?.team ? teamColor(feed.team) : undefined;
  const fill = color ? stockFill(stock) : null;
  const background =
    !color || (fill === null && empty)
      ? undefined
      : fill === null
      ? color
      : `linear-gradient(to top, ${color} ${
          fill * 100
        }%, color-mix(in srgb, ${color} 32%, var(--hat-gauge-base)) ${fill * 100}%)`;
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
      style={{ ...style, background, ...(color && { '--team': color }) } as React.CSSProperties}
      data-fill={fill ?? undefined}
    >
      <HatIcon size={17} />
      {joined && stock && <RefillTimer stock={stock} />}
      {placed && (
        <span className={classes.tick} data-testid="hat-turf-placed">
          <IconCheck size={8} stroke={4} />
        </span>
      )}
    </button>
  );
}

/**
 * Fills toward the next hat. A CSS animation, set once per due time, so it moves with no renders;
 * useHatStock rereads the stock when it is due, and the new due time restarts it. Hidden at the cap,
 * where no hat is coming: a full timer would say one just arrived.
 */
function RefillTimer({ stock }: { stock: ButtonStock }) {
  const due = stock.nextAt?.getTime();
  return due ? <TimerFill key={due} stock={stock} /> : null;
}

function TimerFill({ stock }: { stock: ButtonStock }) {
  // Read once, at mount: the animation carries it from there.
  const [timer] = useState(() => refillTimer(stock, Date.now()));
  if (!timer) return null;
  return (
    <span
      className={classes.timer}
      aria-hidden="true"
      data-testid="hat-turf-refill-timer"
      data-elapsed={timer.elapsed / timer.period}
      style={
        {
          '--period': `${timer.period}ms`,
          '--elapsed': `-${timer.elapsed}ms`,
        } as React.CSSProperties
      }
    >
      <span className={classes.timerBar}>
        <span className={classes.timerBarFill} />
      </span>
      <svg className={classes.timerRing} viewBox="0 0 36 36">
        <circle className={classes.timerTrack} cx="18" cy="18" r="16" />
        <circle className={classes.timerArc} cx="18" cy="18" r="16" pathLength={1} />
      </svg>
    </span>
  );
}
