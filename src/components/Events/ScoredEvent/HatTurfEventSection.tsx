import { Button, Text, UnstyledButton } from '@mantine/core';
import { IconPlayerPlayFilled } from '@tabler/icons-react';
import { useEffect, useRef } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useTeamColor } from '~/components/Events/events.utils';
import {
  HAT_TURF_ART,
  HAT_TURF_VIDEO,
  HAT_TURF_VIDEO_DURATION,
  HAT_TURF_VIDEO_TITLE,
} from '~/components/Events/ScoredEvent/hat-turf-section.constants';
import styles from '~/components/Events/ScoredEvent/HatTurfEventSection.module.scss';
import HatTurfVideoModal from '~/components/Events/ScoredEvent/HatTurfVideoModal';
import { filmLength } from '~/components/Events/ScoredEvent/scored-event.utils';
import { HatTurfSectionStats } from '~/components/Events/ScoredEvent/HatTurfSectionStats';
import { HeroBulbs } from '~/components/Events/ScoredEvent/HeroBulbs';
import { useJoin, useTurfGate } from '~/components/HatTurf/useHatTurf';
import { useHatTurfFeedPlayer } from '~/components/HatTurf/useHatTurfFeedPlayer';
import { NextLink } from '~/components/NextLink/NextLink';
import { useSetFilters } from '~/providers/FiltersProvider';

/** The page anchor articles link to: /events/<event>#hat-turf. */
export const HAT_TURF_ANCHOR = 'hat-turf';

/**
 * Join or leave Hat Turf from the event page. Only for a signed-in viewer on a team, while turf runs
 * for this event on a surface they can see (the same gate as the account setting).
 */
export function HatTurfEventSection({
  event,
  team,
  teams = [],
  video = HAT_TURF_VIDEO,
  duration = HAT_TURF_VIDEO_DURATION,
}: {
  event: string;
  team?: string;
  /** The event's teams, for the colors of the bulbs along the top. */
  teams?: readonly string[];
  /** The song's URL or CDN id; empty hides the play button. */
  video?: string;
  /** The song's length in seconds; 0 hides the label. */
  duration?: number;
}) {
  const gate = useTurfGate(!!team);
  const teamColor = useTeamColor();
  const stock = gate.event === event ? gate.stock : undefined;
  const setOptIn = useJoin();
  const shown = !!stock;
  // The section mounts after its queries, too late for the browser's own jump to the anchor.
  const ref = useRef<HTMLDivElement>(null);
  const jumped = useRef(false);
  useEffect(() => {
    if (!shown || jumped.current || window.location.hash !== `#${HAT_TURF_ANCHOR}`) return;
    jumped.current = true;
    ref.current?.scrollIntoView({ block: 'center' });
  }, [shown]);
  if (!shown) return null;

  const joined = stock.optedIn;
  const colors = teams.map((t) => teamColor(t)).filter((c): c is string => !!c);
  const watch = () =>
    dialogStore.trigger({
      component: HatTurfVideoModal,
      props: { video, title: HAT_TURF_VIDEO_TITLE },
    });

  return (
    <div className="@container">
      <div
        ref={ref}
        id={HAT_TURF_ANCHOR}
        className={`${styles.party} grid rounded-[18px] @sm:min-h-[150px] @sm:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]`}
        data-testid="hat-turf-event-section"
      >
        <HeroBulbs colors={colors} count={18} />
        <div className="relative z-[3] flex flex-col justify-center gap-1.5 px-5 py-4 @sm:px-7">
          <Text className="text-xs font-bold uppercase tracking-[0.18em]" c="yellow.4">
            Hat Turf
          </Text>
          <Text component="h2" className="m-0 text-[22px] font-extrabold leading-tight">
            Claim every picture
            <br />
            <span className={styles.accent}>for your team.</span>
          </Text>
          <Text size="sm" c="gray.4" maw={440}>
            {joined ? "You're in. " : ''}
            Put your team&apos;s hat on any picture to claim it. The more of your team on one
            picture, the bigger your share. Hats last 48 hours. Place your team&apos;s hat again
            once yours expires to keep the picture; points you&apos;ve earned are never taken back.
            Teams that are behind earn a bigger share on the pictures they lead.
          </Text>
          <div className="mt-0.5">
            <Button
              size="sm"
              radius="xl"
              color={joined ? 'gray' : 'yellow'}
              variant={joined ? 'default' : 'filled'}
              loading={setOptIn.isPending}
              onClick={() => setOptIn.mutate({ event, optedIn: !joined })}
            >
              {joined ? 'Leave Hat Turf' : 'Join Hat Turf'}
            </Button>
            {joined && stock.liveHats > 0 && (
              <MyLiveHatsLink event={event} count={stock.liveHats} />
            )}
          </div>
        </div>
        <div className="relative order-first h-[130px] @sm:order-none @sm:h-auto">
          <EdgeMedia
            src={HAT_TURF_ART}
            width={640}
            alt=""
            className={`${styles.art} absolute inset-0 size-full object-cover object-[75%_15%]`}
            data-testid="hat-turf-art"
          />
          {video && (
            <UnstyledButton
              onClick={watch}
              aria-label={`Watch the ${HAT_TURF_VIDEO_TITLE} video`}
              data-testid="hat-turf-play"
              className="group absolute left-[30%] top-1/2 z-[3] -translate-x-1/2 -translate-y-1/2"
            >
              <span className="flex flex-col items-center gap-1.5">
                <span className="flex size-[52px] items-center justify-center rounded-full border border-solid border-white/50 bg-white/30 text-white shadow-lg backdrop-blur-md transition-transform group-hover:scale-110">
                  <IconPlayerPlayFilled size={22} />
                </span>
                {Number.isFinite(duration) && Math.round(duration) > 0 && (
                  <span
                    className="rounded-full bg-dark-9/70 px-2.5 py-0.5 text-xs font-semibold text-white backdrop-blur-sm"
                    data-testid="hat-turf-duration"
                  >
                    Watch · {filmLength(duration)}
                  </span>
                )}
              </span>
            </UnstyledButton>
          )}
        </div>
        {joined && (
          <HatTurfSectionStats
            perHour={stock.perHour}
            cap={stock.cap}
            creditedPlayers={stock.creditedPlayers}
            multiplier={stock.multiplier}
          />
        )}
      </div>
    </div>
  );
}

/** Opens the image feed on the viewer's own live hats, for feed players only, as the feed serves it. */
function MyLiveHatsLink({ event, count }: { event: string; count: number }) {
  const player = useHatTurfFeedPlayer();
  const setImageFilters = useSetFilters('images');
  if (player?.event !== event) return null;
  return (
    <Button
      component={NextLink}
      href="/images"
      size="sm"
      radius="xl"
      color="yellow"
      variant="light"
      ml="xs"
      onClick={() => setImageFilters({ hatTurfMine: true })}
      data-testid="hat-turf-my-hats"
    >
      My live hats ({count})
    </Button>
  );
}
