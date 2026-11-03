import { useState } from 'react';
import { Popover, Text, UnstyledButton } from '@mantine/core';
import { IconCheck, IconSettings } from '@tabler/icons-react';
import clsx from 'clsx';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import { useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import classes from '~/components/HatTurf/HatTurfButton.module.css';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import { TeamHat } from '~/components/HatTurf/TeamHat';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { useChosenHat, useHatStock } from '~/components/HatTurf/useHatTurf';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showInfoNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The card's hat button: a hat and how many the viewer can still place, so the count is there
 * before pressing. Pressing drops a draft hat on the picture to drag and save (HatTurfDraftLayer).
 * The gear on its corner, always on screen, picks which hat is placed. Hidden on the viewer's own
 * images and when signed out; greyed at zero (no refill timing is shown), green once placed here.
 */
export function HatTurfButton({ ownerId }: { ownerId: number }) {
  const feed = useTurfFeed();
  const user = useCurrentUser();
  const card = useHatTurfCard();
  const stock = useHatStock();
  const { cosmeticId } = useChosenHat();
  const [menu, setMenu] = useState(false);

  if (!feed || !card || !user || user.id === ownerId) return null;

  const { draft, setDraft, placed } = card;
  const available = stock?.available;
  const empty = available === 0 && !placed;
  const label = placed
    ? 'Your hat is placed here'
    : empty
    ? 'No hats left to place'
    : `Place a hat, ${available ?? 'some'} available`;

  const press = (event: React.MouseEvent) => {
    // The card is a link and this sits inside it.
    event.preventDefault();
    event.stopPropagation();
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
    setDraft(draft ?? { x: 0.5, y: 0.4 });
  };

  return (
    <div className={classes.wrap} data-testid="hat-turf-button">
      <UnstyledButton
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
        <span data-testid="hat-turf-stock">{available ?? ''}</span>
      </UnstyledButton>
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
            <IconSettings size={11} stroke={2.5} />
          </button>
        </Popover.Target>
        <Popover.Dropdown p={6} onClick={(event) => event.stopPropagation()}>
          <HatChoices onPicked={() => setMenu(false)} />
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
    <div role="listbox" aria-label="Hat to place" style={{ minWidth: 170 }}>
      <Text size="xs" fw={700} c="dimmed" tt="uppercase" px={8} pb={4}>
        Hat to place
      </Text>
      {!hats?.length && (
        <Text size="sm" px={8} py={4}>
          You have no hats to place yet.
        </Text>
      )}
      {hats?.map((hat, index) => (
        <UnstyledButton
          key={hat.cosmeticId}
          role="option"
          aria-selected={hat.cosmeticId === cosmeticId}
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
        </UnstyledButton>
      ))}
    </div>
  );
}
