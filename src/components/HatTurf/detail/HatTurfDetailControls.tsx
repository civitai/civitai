import { useState } from 'react';
import { Button, Drawer, Popover, Switch, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconLock } from '@tabler/icons-react';
import clsx from 'clsx';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import { HatTurfBadge } from '~/components/HatTurf/HatTurfBadge';
import { useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import { TeamHat } from '~/components/HatTurf/TeamHat';
import { useTurfFeed, useTurfSummary } from '~/components/HatTurf/TurfSummaryProvider';
import classes from '~/components/HatTurf/detail/HatTurfDetailControls.module.css';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { badgeLeader, orderedTeams } from '~/components/HatTurf/hat-turf.utils';
import { useChosenHat, useHatStock } from '~/components/HatTurf/useHatTurf';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { showErrorNotification, showInfoNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const DEFAULT_SPOT = { x: 0.5, y: 0.4 };
const INVITE_SNOOZE_MS = 24 * 60 * 60 * 1000;
const FALLBACK = 'var(--mantine-color-gray-6)';
const COVER_HATS = [
  { left: '8%', top: '30%', rotate: -15, color: 'var(--mantine-color-blue-4)' },
  { left: '32%', top: '8%', rotate: 10, color: 'var(--mantine-color-pink-4)' },
  { left: '60%', top: '34%', rotate: -8, color: 'var(--mantine-color-yellow-4)' },
  { left: '82%', top: '6%', rotate: 14, color: 'var(--mantine-color-green-4)' },
];

const capitalise = (team: string) => team[0].toUpperCase() + team.slice(1);

/** The hat button and the standings badge for the picture on screen. Nothing when Hat Turf is off. */
export function HatTurfDetailControls({ imageId }: { imageId: number }) {
  return useTurfFeed() ? (
    <div className={classes.group} data-testid="hat-turf-detail-controls">
      <HatTurfDetailBadge imageId={imageId} />
      <HatButton imageId={imageId} />
    </div>
  ) : null;
}

function useJoin() {
  const utils = trpc.useUtils();
  return trpc.hatTurf.setOptIn.useMutation({
    onSuccess: () => void utils.hatTurf.getStock.invalidate(),
    onError: (error) => showErrorNotification({ title: "Couldn't update Hat Turf", error }),
  });
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

  if (!feed || !card || !user || feed.open[imageId] === false) return null;
  const joined = stock?.optedIn === true;
  const snoozed = Date.now() - dismissedAt < INVITE_SNOOZE_MS;
  const showInvite = inviteOpen ?? (!!stock && !joined && !snoozed);
  const placed =
    card.placed || feed.stickers[imageId]?.some((sticker) => sticker.userId === user.id);
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
        <button
          type="button"
          className={clsx(
            classes.hat,
            joined && classes.hatOn,
            !!card.draft && classes.hatActive,
            (empty || !!placed) && classes.hatEmpty
          )}
          data-testid="hat-turf-detail-hat"
          aria-label={joined ? 'Place your cap' : 'Join Hat Turf'}
          aria-pressed={joined ? !!card.draft : undefined}
          onClick={press}
        >
          <HatIcon size={18} />
        </button>
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

/** The feed's badge, tap for every team's count, the hat to place, show hats and leaving. */
export function HatTurfDetailBadge({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  const summary = useTurfSummary(imageId);
  const user = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [tray, setTray] = useState(false);
  if (!feed || (!summary && !user)) return null;

  return (
    <>
      <Popover
        opened={open}
        onChange={setOpen}
        position="top"
        width={230}
        withArrow
        withinPortal
        shadow="md"
      >
        <Popover.Target>
          <button
            type="button"
            className={classes.badgeButton}
            data-testid="hat-turf-detail-badge"
            aria-label="Hat Turf standings"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {summary ? (
              <HatTurfBadge imageId={imageId} />
            ) : (
              <span className={classes.badgeEmpty}>
                <HatIcon size={18} />
              </span>
            )}
          </button>
        </Popover.Target>
        <Popover.Dropdown className={classes.stats} data-testid="hat-turf-detail-stats">
          <StatsCard
            imageId={imageId}
            onChange={() => {
              setOpen(false);
              setTray(true);
            }}
          />
        </Popover.Dropdown>
      </Popover>
      <HatTray imageId={imageId} opened={tray} onClose={() => setTray(false)} />
    </>
  );
}

function StatsCard({ imageId, onChange }: { imageId: number; onChange: () => void }) {
  const feed = useTurfFeed();
  const summary = useTurfSummary(imageId);
  const user = useCurrentUser();
  const teamColor = useTeamColor();
  const stock = useHatStock();
  const showHats = useHatTurfStore((state) => state.showHats);
  const setShowHats = useHatTurfStore((state) => state.setShowHats);
  const { hats, cosmeticId } = useChosenHat();
  const { data: named } = trpc.event.getMyHats.useQuery(
    { event: feed?.event ?? '' },
    { enabled: !!user, staleTime: 5 * 60_000 }
  );
  const join = useJoin();
  if (!feed) return null;

  const counted = summary?.counted ?? {};
  const leader = summary ? badgeLeader(summary) : null;
  const teams = orderedTeams(counted)
    .filter((team) => (counted[team] ?? 0) > 0)
    .sort((a, b) => (counted[b] ?? 0) - (counted[a] ?? 0) || a.localeCompare(b));
  const color = (team: string) => teamColor(team) ?? FALLBACK;
  const activeIndex = hats?.findIndex((hat) => hat.cosmeticId === cosmeticId) ?? -1;
  const activeName =
    named?.find((hat) => hat.cosmeticId === cosmeticId)?.name ??
    (activeIndex >= 0 ? `Hat ${activeIndex + 1}` : null);

  return (
    <div>
      {!teams.length && <Text size="xs">No hats on this image yet.</Text>}
      {teams.map((team) => (
        <div key={team} className={classes.row} data-testid="hat-turf-detail-team">
          {summary?.hatted && team === leader && <IconLock size={12} />}
          <i className={classes.dot} style={{ backgroundColor: color(team) }} />
          {capitalise(team)}
          {team === leader && (
            <span className={classes.tag}>{summary?.hatted ? 'would lead' : 'leads'}</span>
          )}
          <span className={classes.count}>{counted[team]}</span>
        </div>
      ))}
      {summary?.hatted && leader && (
        <Text size="xs" c="dimmed" mt={4}>
          Protected by the owner&apos;s hat. {capitalise(leader)} takes the image if it comes off.
        </Text>
      )}
      <hr style={{ border: 0, borderTop: '1px solid var(--mantine-color-default-border)' }} />
      {user && stock?.optedIn && activeName && (
        <div className={classes.row}>
          <TeamHat color={(feed.team && color(feed.team)) || FALLBACK} size={16} />
          {activeName}
          <button type="button" className={classes.link} onClick={onChange}>
            change ▸
          </button>
        </div>
      )}
      <div className={classes.row}>
        <Switch
          size="xs"
          label="Show hats"
          labelPosition="left"
          checked={showHats}
          onChange={(event) => setShowHats(event.currentTarget.checked)}
          styles={{ root: { width: '100%' }, body: { justifyContent: 'space-between' } }}
        />
      </div>
      {user && stock?.optedIn && (
        <>
          <hr style={{ border: 0, borderTop: '1px solid var(--mantine-color-default-border)' }} />
          <button
            type="button"
            className={classes.link}
            disabled={join.isPending}
            onClick={() => join.mutate({ event: feed.event, optedIn: false })}
          >
            Leave Hat Turf
          </button>
          <Text size="xs" c="dimmed">
            Hats already on your images keep counting. No new ones can be placed.
          </Text>
        </>
      )}
    </div>
  );
}

/** The hats a player owns, most used first; picking one makes it the active hat and drops it. */
function HatTray({
  imageId,
  opened,
  onClose,
}: {
  imageId: number;
  opened: boolean;
  onClose: () => void;
}) {
  const feed = useTurfFeed();
  const card = useHatTurfCard();
  const mobile = useIsMobile({ type: 'media' });
  const teamColor = useTeamColor();
  const pick = useHatTurfStore((state) => state.pick);
  const { hats, cosmeticId } = useChosenHat();
  const { data: named } = trpc.event.getMyHats.useQuery(
    { event: feed?.event ?? '' },
    { enabled: opened, staleTime: 5 * 60_000 }
  );
  if (!feed || !card) return null;

  const color = (feed.team && teamColor(feed.team)) || FALLBACK;
  const ordered = [...(hats ?? [])].sort(
    (a, b) => b.usageCount - a.usageCount || a.cosmeticId - b.cosmeticId
  );
  const body = (
    <div data-testid="hat-turf-detail-tray">
      <Text size="xs" c="dimmed">
        Most used first
      </Text>
      {!ordered.length && <Text size="sm">You have no hats to place yet.</Text>}
      <div className={classes.tiles}>
        {ordered.map((hat, index) => (
          <button
            type="button"
            key={hat.cosmeticId}
            aria-pressed={hat.cosmeticId === cosmeticId}
            className={clsx(classes.tile, hat.cosmeticId === cosmeticId && classes.tileActive)}
            onClick={() => {
              pick(hat.cosmeticId);
              card.setDraft(card.draft ?? DEFAULT_SPOT);
              onClose();
            }}
          >
            <TeamHat color={color} size={34} />
            {named?.find((h) => h.cosmeticId === hat.cosmeticId)?.name ?? `Hat ${index + 1}`}
            <span>{hat.usageCount} used</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position={mobile ? 'bottom' : 'right'}
      size={mobile ? '45%' : 340}
      title="Your hats"
      data-image-id={imageId}
    >
      {body}
    </Drawer>
  );
}
