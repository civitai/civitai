import clsx from 'clsx';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Button, Drawer, Switch, Text } from '@mantine/core';
import { Popover } from '~/components/MantineOverlays';
import { IconLock } from '@tabler/icons-react';
import { getCountdownString } from '~/components/Countdown/Countdown';
import { PAGE_MODAL_Z_INDEX } from '~/components/Dialog/Templates/PageModal';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import { useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import { HatPicture } from '~/components/HatTurf/HatPicture';
import classes from '~/components/HatTurf/HatTurfPanel.module.css';
import { HatTurfTray } from '~/components/HatTurf/HatTurfTray';
import { useTurfFeed, useTurfSummary } from '~/components/HatTurf/TurfSummaryProvider';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { FALLBACK_COLOR, badgeLeader, orderedTeams } from '~/components/HatTurf/hat-turf.utils';
import { useChosenHat, useHatLooks, useHatStock, useJoin } from '~/components/HatTurf/useHatTurf';
import { useHatTurfAction } from '~/components/HatTurf/useHatTurfAction';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { ExperimentSurface } from '~/shared/constants/experiments.constants';
import dayjs from '~/shared/utils/dayjs';

export const DEFAULT_SPOT = { x: 0.5, y: 0.4 };

const capitalise = (team: string) => team[0].toUpperCase() + team.slice(1);

/**
 * The Hat Turf panel for one image, opened from `target`: a popover on desktop, a bottom sheet on a
 * phone. "Change" swaps it for the hats tray, and picking a hat there brings it back.
 */
export function HatTurfPanelPopover({
  imageId,
  surface,
  placed,
  opened,
  onOpenChange,
  target,
  position = 'top',
}: {
  imageId: number;
  surface: ExperimentSurface;
  placed: boolean;
  opened: boolean;
  onOpenChange: (opened: boolean) => void;
  target: ReactElement;
  position?: 'top' | 'top-end' | 'bottom-start';
}) {
  const mobile = useIsMobile({ type: 'media' });
  const [tray, setTray] = useState(false);
  const panel = (
    <HatTurfPanel
      imageId={imageId}
      surface={surface}
      placed={placed}
      onClose={() => onOpenChange(false)}
      onChange={() => {
        onOpenChange(false);
        setTray(true);
      }}
    />
  );
  // Mounted only while open: every feed card has a gear, and a closed tray would still cost each one.
  const trayEl = tray && (
    <HatTurfTray
      opened={tray}
      onClose={() => setTray(false)}
      onPicked={() => {
        setTray(false);
        onOpenChange(true);
      }}
    />
  );

  if (mobile)
    return (
      <>
        {target}
        {/* Portalled, but React still bubbles its clicks (overlay, close) to the card around the gear. */}
        <span className="contents" onClick={(event) => event.stopPropagation()}>
          <Drawer
            opened={opened}
            onClose={() => onOpenChange(false)}
            position="bottom"
            withCloseButton={false}
            // The image modal is a PageModal; at Mantine's default the sheet opens hidden under it.
            zIndex={PAGE_MODAL_Z_INDEX + 1}
            classNames={{ content: classes.sheet, body: classes.sheetBody }}
          >
            {/* Focus lands on the sheet, not on its first button, so nothing shows a focus ring on open. */}
            <div
              data-autofocus
              tabIndex={-1}
              className="outline-none"
              onClick={(event) => event.stopPropagation()}
            >
              {panel}
            </div>
          </Drawer>
          {trayEl}
        </span>
      </>
    );

  return (
    <>
      <Popover
        opened={opened}
        onChange={onOpenChange}
        position={position}
        width={300}
        withArrow
        withinPortal
        shadow="md"
      >
        <Popover.Target>{target}</Popover.Target>
        <Popover.Dropdown
          className={classes.dropdown}
          data-testid="hat-turf-panel-popover"
          onClick={(event) => event.stopPropagation()}
        >
          {panel}
        </Popover.Dropdown>
      </Popover>
      <span className="contents" onClick={(event) => event.stopPropagation()}>
        {trayEl}
      </span>
    </>
  );
}

/**
 * Your hat and what's left of your supply, the image's standings, then Show hats.
 * No Leave here by product decision: leaving is on the event page's Hat Turf section and the
 * "Take part in Hat Turf" account setting.
 */
export function HatTurfPanel({
  imageId,
  surface,
  placed,
  onChange,
  onClose,
}: {
  imageId: number;
  surface: ExperimentSurface;
  placed: boolean;
  onChange: () => void;
  onClose: () => void;
}) {
  const feed = useTurfFeed();
  const user = useCurrentUser();
  const stock = useHatStock();
  const card = useHatTurfCard();
  const teamColor = useTeamColor();
  const track = useHatTurfAction(surface);
  const showHats = useHatTurfStore((state) => state.showHats);
  const setShowHats = useHatTurfStore((state) => state.setShowHats);
  const optIn = useJoin();
  const { cosmeticId } = useChosenHat();
  const mobile = useIsMobile({ type: 'media' });
  if (!feed) return null;

  const joined = !!user && stock?.optedIn === true;
  const noHat = !cosmeticId;
  const closed = feed.open[imageId] === false;
  const color = (team: string) => teamColor(team) ?? FALLBACK_COLOR;

  return (
    <div className={classes.panel} data-testid="hat-turf-panel">
      {joined && stock && (
        <>
          <div className={classes.pad}>
            {closed ? (
              <Text size="xs" c="dimmed" data-testid="hat-turf-detail-closed">
                Hats can&apos;t go on this picture
              </Text>
            ) : (
              <YourHat
                teamColor={feed.team ? color(feed.team) : FALLBACK_COLOR}
                onChange={onChange}
              />
            )}
            <Supply
              available={stock.available}
              cap={stock.cap}
              nextAt={stock.nextAt}
              color={feed.team ? color(feed.team) : FALLBACK_COLOR}
            />
            {!closed && card && (
              <Button
                fullWidth
                mt="sm"
                className={classes.place}
                style={{ backgroundColor: feed.team ? color(feed.team) : undefined }}
                leftSection={<HatIcon size={16} />}
                disabled={placed || stock.available === 0 || noHat}
                data-testid="hat-turf-panel-place"
                onClick={() => {
                  card.setDraft(card.draft ?? DEFAULT_SPOT);
                  if (surface === 'feed-card') track('feed_place_start', feed.event);
                  onClose();
                }}
              >
                {placed
                  ? 'Your hat is on this image'
                  : stock.available === 0
                  ? 'Out of hats'
                  : 'Place hat'}
              </Button>
            )}
          </div>
          <hr className={classes.divider} />
        </>
      )}
      <div className={classes.pad}>
        <Standings
          imageId={imageId}
          color={color}
          closed={closed}
          joined={joined}
          signedIn={!!user}
          outOfHats={stock?.available === 0}
          joining={optIn.isPending}
          onJoin={() => optIn.mutate({ event: feed.event, optedIn: true })}
        />
      </div>
      <hr className={classes.divider} />
      <div className={clsx(classes.pad, classes.showHatsPad)}>
        {/* The switch first and its label right after it; on a phone a bigger switch in a full
            36px tap row. */}
        <Switch
          size={mobile ? 'md' : 'xs'}
          label="Show hats"
          checked={showHats}
          onChange={(event) => {
            const show = event.currentTarget.checked;
            setShowHats(show);
            track(show ? 'hide_all_hats_off' : 'hide_all_hats_on', feed.event);
          }}
          classNames={{ body: classes.showHats }}
          data-testid="hat-turf-show-hats"
        />
      </div>
    </div>
  );
}

function YourHat({ teamColor, onChange }: { teamColor: string; onChange: () => void }) {
  const { cosmeticId, hats } = useChosenHat();
  const look = useHatLooks()(cosmeticId);
  if (!hats?.length) return <Text size="sm">You have no hats to place yet.</Text>;

  return (
    <div className={classes.yourHat}>
      <HatPicture data={look?.data} color={teamColor} size={64} />
      <div className={classes.yourHatText}>
        <span className={classes.eyebrow}>Your hat</span>
        <div className={classes.yourHatRow}>
          <span className={classes.hatName} data-testid="hat-turf-panel-hat">
            {look?.name ?? 'Your hat'}
          </span>
          <Button
            size="compact-sm"
            variant="default"
            data-testid="hat-turf-panel-change"
            onClick={onChange}
          >
            Change
          </Button>
        </div>
      </div>
    </div>
  );
}

function Supply({
  available,
  cap,
  nextAt,
  color,
}: {
  available: number;
  cap: number;
  nextAt: Date | null;
  color: string;
}) {
  // useHatStock rereads the stock when the next hat is due, so the count and countdown move on.
  return (
    <div className={classes.supply} data-testid="hat-turf-panel-supply">
      <div className={classes.supplyRow}>
        <span>
          <b className={classes.num} data-testid="hat-turf-detail-left">
            {available}
          </b>{' '}
          <span className={classes.dim}>of {cap} hats</span>
        </span>
        <span className={classes.dim} data-testid="hat-turf-panel-refill">
          {nextAt ? (
            <>
              +1 in{' '}
              <b className={classes.countdown}>
                <Ticking until={nextAt} />
              </b>
            </>
          ) : (
            'Full'
          )}
        </span>
      </div>
      <div className={classes.meter}>
        <b
          style={{
            width: `${cap ? Math.min(100, (available / cap) * 100) : 0}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );
}

/** "7m 12s" to `until`, redrawn each second. Opened panels only, so no server render to match. */
function Ticking({ until }: { until: Date }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, until.getTime() - now);
  return <>{left ? getCountdownString(dayjs.duration(left), 'short', true) : 'now'}</>;
}

function Standings({
  imageId,
  color,
  closed,
  joined,
  signedIn,
  outOfHats,
  joining,
  onJoin,
}: {
  imageId: number;
  color: (team: string) => string;
  closed: boolean;
  joined: boolean;
  signedIn: boolean;
  outOfHats: boolean;
  joining: boolean;
  onJoin: () => void;
}) {
  const summary = useTurfSummary(imageId);
  const counted = summary?.counted ?? {};
  const leader = summary ? badgeLeader(summary) : null;
  const teams = orderedTeams(counted)
    .filter((team) => (counted[team] ?? 0) > 0)
    .sort((a, b) => (counted[b] ?? 0) - (counted[a] ?? 0) || a.localeCompare(b));
  const total = teams.reduce((sum, team) => sum + (counted[team] ?? 0), 0);
  // The hat's team comes from its placement and may be cased differently from the counts' keys.
  const holder = summary?.hatted ? summary.hattedTeam : null;
  const join =
    signedIn && !joined && !closed ? (
      <Button
        size="compact-xs"
        color="yellow"
        radius="xl"
        mt={6}
        loading={joining}
        onClick={onJoin}
      >
        Join Hat Turf
      </Button>
    ) : null;

  if (!leader)
    return (
      <div data-testid="hat-turf-detail-empty">
        <Text size="xs" fw={600}>
          No hats on this image yet
        </Text>
        {!closed && (
          <Text size="xs" c="dimmed">
            {!signedIn
              ? "Sign in and join Hat Turf to put your team's hat on it first."
              : !joined
              ? "Join Hat Turf to put your team's hat on it first."
              : outOfHats
              ? "You're out of hats for now. You get more as the event goes on."
              : "Be the first: tap the hat button to put your team's hat on it."}
          </Text>
        )}
        {join}
      </div>
    );

  return (
    <div data-testid="hat-turf-panel-standings">
      <div className={classes.standingsHead}>
        <span className={classes.standingsTitle}>
          {capitalise(leader)} leads
          {holder && holder.toLowerCase() !== leader.toLowerCase() && (
            <> · {capitalise(holder)} holds</>
          )}
          {summary?.hatted && <IconLock size={12} />}
        </span>
        <span className={classes.dim}>{total} hats</span>
      </div>
      <div className={classes.bar}>
        {teams.map((team) => (
          <span
            key={team}
            style={{ flexGrow: counted[team], backgroundColor: color(team) }}
            data-team={team}
          />
        ))}
      </div>
      <div className={classes.legend}>
        {teams.map((team) => (
          <span key={team} data-testid="hat-turf-detail-team">
            <i className={classes.dot} style={{ backgroundColor: color(team) }} />
            {capitalise(team)} <b>{counted[team]}</b>
          </span>
        ))}
      </div>
      {summary?.hatted && (
        <Text size="xs" c="dimmed" mt={6}>
          {holder
            ? `The owner's hat protects it for ${capitalise(holder)} until it comes off.`
            : "Protected by the owner's hat until it comes off."}
        </Text>
      )}
      {join}
    </div>
  );
}
