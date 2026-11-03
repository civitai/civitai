import { useState } from 'react';
import { Button, Popover, Switch, Text } from '@mantine/core';
import { IconCheck, IconSettings } from '@tabler/icons-react';
import clsx from 'clsx';
import { useTeamColor } from '~/components/Events/events.utils';
import { useExperimentExposure } from '~/components/Experiments/useExperimentExposure';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import { useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import classes from '~/components/HatTurf/HatTurfButton.module.css';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import { TeamHat } from '~/components/HatTurf/TeamHat';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { useChosenHat, useHatStock } from '~/components/HatTurf/useHatTurf';
import { useHatTurfAction } from '~/components/HatTurf/useHatTurfAction';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification, showInfoNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Hidden when signed out or the image can't take a hat.
 */
export function HatTurfButton({ imageId }: { imageId: number }) {
  return useTurfFeed() ? <HatTurfButtonContent imageId={imageId} /> : null;
}

function HatTurfButtonContent({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  const user = useCurrentUser();
  const card = useHatTurfCard();
  const stock = useHatStock();
  const { cosmeticId } = useChosenHat();
  const showHats = useHatTurfStore((state) => state.showHats);
  const setShowHats = useHatTurfStore((state) => state.setShowHats);
  const [menu, setMenu] = useState(false);
  const [join, setJoin] = useState(false);
  const exposureRef = useExperimentExposure('hatTurfFeedCard', 'feed-card');
  const track = useHatTurfAction('feed-card');
  const utils = trpc.useUtils();
  const setOptIn = trpc.hatTurf.setOptIn.useMutation({
    onSuccess: () => {
      setJoin(false);
      void utils.hatTurf.getStock.invalidate();
    },
    onError: (error) => showErrorNotification({ title: "Couldn't join Hat Turf", error }),
  });

  if (!feed || !card || !user || feed.open[imageId] === false) return null;

  const { draft, setDraft } = card;
  const placed =
    card.placed || feed.stickers[imageId]?.some((sticker) => sticker.userId === user.id);
  const joined = stock?.optedIn !== false;
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
    setDraft({ x: 0.5, y: 0.4 });
    track('feed_place_start', feed.event);
  };

  return (
    <div ref={exposureRef} className={classes.wrap} data-testid="hat-turf-button">
      <button
        type="button"
        className={clsx(
          classes.button,
          empty && classes.empty,
          !!placed && classes.done,
          !!draft && classes.active
        )}
        aria-label={label}
        aria-pressed={!!draft}
        onClick={press}
      >
        {placed ? <IconCheck size={14} stroke={3} /> : <HatIcon size={14} />}
        <span data-testid="hat-turf-stock">{joined ? available ?? '' : '+'}</span>
      </button>
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
      <Popover
        opened={menu}
        onChange={setMenu}
        withinPortal
        position="top-end"
        withArrow
        shadow="md"
      >
        <Popover.Target>
          <button
            type="button"
            className={classes.gear}
            aria-label="Choose which hat to place"
            data-testid="hat-turf-gear"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setMenu((open) => !open);
            }}
          >
            <IconSettings size={10} stroke={2.5} />
          </button>
        </Popover.Target>
        <Popover.Dropdown p={6} onClick={(event) => event.stopPropagation()}>
          <HatChoices onPicked={() => setMenu(false)} />
          <Switch
            mt={6}
            px={8}
            size="xs"
            label="Show hats"
            checked={showHats}
            onChange={(event) => {
              const show = event.currentTarget.checked;
              setShowHats(show);
              track(show ? 'hide_all_hats_off' : 'hide_all_hats_on', feed.event);
            }}
          />
        </Popover.Dropdown>
      </Popover>
    </div>
  );
}

function HatChoices({ onPicked }: { onPicked: () => void }) {
  const feed = useTurfFeed();
  const teamColor = useTeamColor();
  const pick = useHatTurfStore((state) => state.pick);
  const { cosmeticId, hats } = useChosenHat();
  // Names live on the event's own hat list; loaded only once someone opens this menu.
  const { data: named } = trpc.event.getMyHats.useQuery(
    { event: feed?.event ?? '' },
    { staleTime: 5 * 60_000 }
  );
  const color = (feed?.team && teamColor(feed.team)) || 'var(--mantine-color-gray-6)';

  return (
    <div role="group" aria-label="Hat to place" style={{ minWidth: 170 }}>
      <Text size="xs" fw={700} c="dimmed" tt="uppercase" px={8} pb={4}>
        Hat to place
      </Text>
      {!hats?.length && (
        <Text size="sm" px={8} py={4}>
          You have no hats to place yet.
        </Text>
      )}
      {hats?.map((hat, index) => (
        <button
          type="button"
          key={hat.cosmeticId}
          aria-pressed={hat.cosmeticId === cosmeticId}
          className={clsx(classes.option, hat.cosmeticId === cosmeticId && classes.selected)}
          onClick={() => {
            pick(hat.cosmeticId);
            onPicked();
          }}
        >
          <TeamHat color={color} size={22} />
          <span>
            {named?.find((h) => h.cosmeticId === hat.cosmeticId)?.name ?? `Hat ${index + 1}`}
          </span>
        </button>
      ))}
    </div>
  );
}
