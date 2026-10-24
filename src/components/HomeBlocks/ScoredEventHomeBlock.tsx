import { ActionIcon, Button, Text, UnstyledButton } from '@mantine/core';
import { IconHanger, IconPlayerPlayFilled, IconPlus, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useMutateEvent, useTeamColor } from '~/components/Events/events.utils';
import { EventContentThumb } from '~/components/Events/ScoredEvent/EventContentThumb';
import {
  MyHatsLivePoints,
  useEventTeamsLivePoints,
} from '~/components/Events/ScoredEvent/event-points-live';
import EventVideoModal from '~/components/Events/ScoredEvent/EventVideoModal';
import { HeroBulbs } from '~/components/Events/ScoredEvent/HeroBulbs';
import { JoinEventButton } from '~/components/Events/ScoredEvent/JoinEventButton';
import PlaceHatModal from '~/components/Events/ScoredEvent/PlaceHatModal';
import { PrizeBadge } from '~/components/Events/ScoredEvent/PrizeBadge';
import { filmLength } from '~/components/Events/ScoredEvent/scored-event.utils';
import { useEventPromos } from '~/components/Events/useEventPromos';
import {
  collapsedLine,
  HOME_BLOCK_HAT_TILES,
  scoredEventHomeBlockCopy,
  scoredEventHomeBlockView,
} from '~/components/HomeBlocks/scored-event-home-block.utils';
import { AnimatedCount } from '~/components/Metrics/AnimatedCount';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useInView } from '~/hooks/useInView';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import type { RouterOutput } from '~/types/router';
import { numberWithCommas } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import styles from './ScoredEventHomeBlock.module.scss';

type EventData = RouterOutput['event']['getData'];
type MyHat = RouterOutput['event']['getMyHats'][number];
type Standings = RouterOutput['event']['getStandings'];

// One short, wide row from this container width up; stacked below it. Literal class strings, so
// Tailwind can see them.
const LAYOUT = {
  join: {
    grid: '@sm:h-[212px] @sm:grid-cols-[minmax(0,1fr)_340px]',
    art: 'h-[130px] order-first @sm:order-none @sm:h-auto',
    fade: '[mask-image:linear-gradient(to_top,transparent,#000_55%)] @sm:[mask-image:linear-gradient(to_right,transparent,#000_45%)]',
    divider: '@sm:border-l',
  },
  wide: {
    grid: '@md:h-[212px] @md:grid-cols-[300px_240px_minmax(0,1fr)_260px]',
    art: 'h-[130px] order-first @md:order-none @md:h-auto',
    fade: '[mask-image:linear-gradient(to_top,transparent,#000_55%)] @md:[mask-image:linear-gradient(to_right,transparent,#000_45%)]',
    divider: '@md:border-l',
  },
} as const;

/**
 * A scored event's home block, in the event page's own look: who you are, where the teams stand,
 * your hats and what they earned, beside the event's art and film. Read from the event's own gated
 * endpoints, never the shared home-block cache; everything but the copy comes from the event
 * definition, so the next scored event needs only a row and its promo copy.
 */
export function ScoredEventHomeBlock({
  event,
  data,
  collapsed,
  onClose,
  onExpand,
}: {
  event: string;
  data: EventData;
  collapsed: boolean;
  /** Collapses the full block; hides the collapsed bar. */
  onClose: () => void;
  onExpand: () => void;
}) {
  const currentUser = useCurrentUser();
  const teamColor = useTeamColor();
  const utils = trpc.useUtils();
  const promo = useEventPromos().find((p) => p.event === event);

  const { data: eventCosmetic, isInitialLoading: loadingTeam } = trpc.event.getCosmetic.useQuery(
    { event },
    { enabled: !!currentUser }
  );
  const team = eventCosmetic?.obtained
    ? (eventCosmetic.cosmetic?.data as { team?: string } | undefined)?.team
    : undefined;
  const { data: standings } = trpc.event.getStandings.useQuery({ event });
  const { data: hats = [] } = trpc.event.getMyHats.useQuery({ event }, { enabled: !!team });
  const { activateCosmetic, equipping } = useMutateEvent();

  const copy = scoredEventHomeBlockCopy(data, promo?.homeBlock);
  const view = scoredEventHomeBlockView({ data, standings, team, hats });
  // A member's points move live while the full block is on screen, as on the event page; frozen
  // once ended, so the winner it names is the settled one. `liveTotals` is off
  // while the scoring engine's kill switch is off, which also stops the block following anything,
  // without a release.
  const { ref: liveRef, inView } = useInView();
  const live = inView && !collapsed && view.state === 'joined' && !!standings?.liveTotals;
  useEventTeamsLivePoints(event, standings?.teamsTopicId, live);
  const eventHref = `/events/${event}`;
  const colors = data.teams.map((t) => teamColor(t)).filter((c): c is string => !!c);
  const hatOf = (t: string) => standings?.teamHats.find((h) => h.team === t)?.url ?? undefined;

  const join = async () => {
    try {
      await activateCosmetic({ event });
      await utils.event.getMyHats.invalidate({ event });
    } catch (e) {
      showErrorNotification({ title: 'Unable to join', error: e as Error });
    }
  };

  // A member would otherwise see the join layout, and its Join button, until their team arrives.
  if (loadingTeam) return <div className={collapsed ? 'min-h-14' : 'min-h-[212px]'} aria-busy />;

  if (collapsed)
    return (
      <div
        className={clsx(styles.party, 'flex items-center gap-3 rounded-2xl p-2 pr-3')}
        data-testid="event-home-block-collapsed"
      >
        <HeroBulbs colors={colors} count={22} />
        {data.page?.heroImage && (
          <div className="relative z-[3] h-10 w-[60px] shrink-0 overflow-hidden rounded-lg">
            <EdgeMedia
              src={data.page.heroImage}
              width={160}
              className="size-full object-cover object-right"
              alt=""
            />
          </div>
        )}
        <Text size="sm" className="relative z-[3] min-w-0 flex-1 truncate">
          <b>{data.title}</b> · {collapsedLine(view)}
        </Text>
        <Button size="compact-sm" radius="xl" variant="white" color="dark" onClick={onExpand}>
          Show
        </Button>
        <ActionIcon variant="subtle" color="gray" aria-label="Hide this event" onClick={onClose}>
          <IconX size={16} />
        </ActionIcon>
      </div>
    );

  const layout = view.state === 'join' ? LAYOUT.join : LAYOUT.wide;
  const ended = view.state === 'ended';
  const video = data.page?.heroVideo;
  const art = data.page?.homeImage ?? data.page?.heroImage;
  const openVideo = () =>
    video &&
    dialogStore.trigger({
      component: EventVideoModal,
      props: { video, onJoin: view.state === 'join' ? join : undefined },
    });

  const headline = (
    <Text component="div" className="text-2xl font-extrabold leading-tight">
      {view.state === 'ended' && view.winner ? (
        <>
          <span style={{ color: teamColor(view.winner) }}>Team {view.winner}</span> wins.
        </>
      ) : (
        <>
          {copy.title}{' '}
          {/* Its own line, and never broken, so no word of it is left alone on a line. */}
          {copy.accent && (
            <span
              className={clsx(styles.accent, 'block w-fit whitespace-nowrap')}
              style={{ backgroundImage: `linear-gradient(90deg, ${colors.join(', ')})` }}
            >
              {copy.accent}
            </span>
          )}
        </>
      )}
    </Text>
  );

  const eyebrow = (
    <Text size="xs" fw={700} tt="uppercase" lts={0.5} c="gray.5">
      {copy.eyebrow}
      {data.preview && (
        <span className="ml-2 rounded-full bg-yellow-5/15 px-2 py-0.5 normal-case tracking-normal text-yellow-4">
          Preview: testers and mods
        </span>
      )}
    </Text>
  );

  return (
    <div
      ref={liveRef}
      // Capped so the stretching column cannot leave a wide empty band on large screens.
      className={clsx(styles.party, 'mx-auto grid max-w-[1400px] rounded-[18px]', layout.grid)}
      data-testid="event-home-block"
    >
      <HeroBulbs colors={colors} count={22} />
      <ActionIcon
        variant="filled"
        color="dark"
        radius="xl"
        className="!absolute right-3 top-3 z-[7] opacity-80"
        aria-label="Collapse this event"
        onClick={onClose}
      >
        <IconX size={14} />
      </ActionIcon>

      {view.state === 'join' && (
        <Column first>
          {eyebrow}
          {headline}
          {copy.body && (
            <Text size="sm" c="gray.4" mt={6} maw={520}>
              {copy.body}
            </Text>
          )}
          <div className="mt-3.5 flex flex-wrap items-center gap-3">
            <JoinEventButton onClick={join} loading={equipping} />
            <div className="ml-1 flex items-end" data-testid="event-home-block-caps">
              {data.teams.map((t, i) => {
                const url = hatOf(t);
                return url ? (
                  <EdgeMedia
                    key={t}
                    src={url}
                    width={80}
                    alt={`${t} cap`}
                    className="-ml-1.5 w-[34px] drop-shadow-lg"
                    style={{ transform: `rotate(${(i - 1.5) * 8}deg)` }}
                  />
                ) : null;
              })}
            </div>
            <Text size="xs" c="gray.5">
              Random team. Teams are final.
            </Text>
          </div>
        </Column>
      )}

      {view.state === 'joined' && (
        <>
          <Column first>
            <Text size="xs" fw={700} tt="uppercase" lts={0.5} c="gray.5">
              {copy.eyebrow}
            </Text>
            {headline}
            <div className="mt-3 flex items-center gap-2.5">
              {hatOf(view.team) && (
                <EdgeMedia
                  src={hatOf(view.team)!}
                  width={80}
                  alt=""
                  className="w-[34px] drop-shadow-lg"
                />
              )}
              <div>
                <Text size="10px" fw={700} tt="uppercase" lts={0.5} c="gray.5">
                  You&apos;re on
                </Text>
                <Text fw={800} size="lg" lh={1.1} c={teamColor(view.team)}>
                  Team {view.team}
                </Text>
              </div>
            </div>
            <div className="mt-3">
              <Button
                component={NextLink}
                href={eventHref}
                size="compact-sm"
                radius="xl"
                variant="white"
                color="dark"
              >
                {copy.cta}
              </Button>
            </div>
          </Column>
          <Column divider={layout.divider} label="Standings">
            {standings && <Positions standings={standings} myTeam={view.team} hatOf={hatOf} />}
          </Column>
          <Column
            divider={layout.divider}
            label="Your hats"
            aside={
              <span style={{ color: teamColor(view.team) }}>
                <AnimatedCount value={view.points} abbreviate={false} /> points
              </span>
            }
          >
            <MyHatsLivePoints event={event} topicIds={hats.map((h) => h.topicId)} inView={live} />
            <HatTiles
              event={event}
              hats={hats}
              shown={view.shownHats}
              more={view.moreHats}
              color={teamColor(view.team)}
            />
          </Column>
        </>
      )}

      {ended && (
        <>
          <Column first>
            {eyebrow}
            {headline}
            {view.winner && data.page?.prize && (
              <div className="mt-3 flex items-center gap-3">
                {data.page.prizeBadge?.[view.winner] && (
                  <PrizeBadge
                    badge={data.page.prizeBadge[view.winner]}
                    width={128}
                    className="w-14 shrink-0"
                  />
                )}
                <div>
                  <Text size="sm" fw={700}>
                    {data.page.prize.title}
                  </Text>
                  <Text size="xs" c="gray.5" lineClamp={2}>
                    {data.page.prize.body}
                  </Text>
                </div>
              </div>
            )}
            {!view.winner && (
              <Text size="sm" c="gray.4" mt={8}>
                Final scores are being tallied.
              </Text>
            )}
          </Column>
          <Column divider={layout.divider} label="Final standings">
            {standings && <Positions standings={standings} myTeam={view.winner} hatOf={hatOf} />}
            <div className="mt-2.5">
              <Button
                component={NextLink}
                href={eventHref}
                size="compact-sm"
                radius="xl"
                variant="white"
                color="dark"
              >
                See the results
              </Button>
            </div>
          </Column>
        </>
      )}

      <div className={clsx('relative overflow-hidden', layout.art)}>
        {/* Faded out by its own alpha rather than painted over, so it melts into whatever the
            surface's gradient is behind it. */}
        {art && (
          <EdgeMedia
            src={art}
            width={640}
            className={clsx(
              'absolute inset-0 size-full object-cover object-[75%_45%]',
              layout.fade
            )}
            alt=""
          />
        )}
        {video && (
          <UnstyledButton
            onClick={openVideo}
            aria-label={`Watch the ${video.title} video`}
            // Centered on the art, and see-through so the art still reads behind it.
            className="group absolute left-1/2 top-1/2 z-[3] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5"
          >
            <span className="flex size-[52px] items-center justify-center rounded-full border border-solid border-white/50 bg-white/30 text-white shadow-lg backdrop-blur-md transition-transform group-hover:scale-110">
              <IconPlayerPlayFilled size={22} />
            </span>
            <span className="rounded-full bg-dark-9/40 px-2.5 py-0.5 text-xs font-bold text-white backdrop-blur-md">
              {Number.isFinite(video.duration) && Math.round(video.duration ?? 0) > 0
                ? `Watch · ${filmLength(video.duration ?? 0)}`
                : 'Watch'}
            </span>
          </UnstyledButton>
        )}
      </div>
    </div>
  );
}

function Column({
  children,
  first,
  label,
  aside,
  divider,
}: {
  children: ReactNode;
  first?: boolean;
  label?: string;
  aside?: ReactNode;
  divider?: string;
}) {
  return (
    <div
      className={clsx(
        'relative z-[3] flex min-w-0 flex-col justify-center px-[22px] py-4',
        first ? 'pt-7' : clsx('border-0 border-solid border-white/[.06]', divider)
      )}
    >
      {label && (
        <Text size="xs" fw={700} tt="uppercase" lts={0.5} c="gray.5" mb={8} className="flex gap-2">
          <span>{label}</span>
          {aside && (
            <>
              <span aria-hidden>·</span>
              {aside}
            </>
          )}
        </Text>
      )}
      {children}
    </div>
  );
}

function Positions({
  standings,
  myTeam,
  hatOf,
}: {
  standings: Standings;
  myTeam?: string;
  hatOf: (team: string) => string | undefined;
}) {
  const teamColor = useTeamColor();
  return (
    <div className="flex flex-col gap-1" data-testid="event-home-block-standings">
      {standings.teams.map((t) => (
        <div
          key={t.team}
          className={clsx(
            'grid grid-cols-[22px_20px_1fr_auto] items-center gap-1.5 rounded-lg px-2 py-0.5 text-sm',
            t.team === myTeam && styles.mine
          )}
          style={{ '--team': teamColor(t.team) } as CSSProperties}
          data-mine={t.team === myTeam || undefined}
        >
          <span className="text-xs font-extrabold text-gray-5">#{t.rank}</span>
          {hatOf(t.team) ? (
            <EdgeMedia src={hatOf(t.team)!} width={40} alt="" className="w-[18px]" />
          ) : (
            <span />
          )}
          <span className="font-bold" style={{ color: teamColor(t.team) }}>
            {t.team}
          </span>
          <span className="font-extrabold tabular-nums">
            <AnimatedCount value={t.score} abbreviate={false} resetKey={t.team} />
          </span>
        </div>
      ))}
    </div>
  );
}

function HatTiles({
  event,
  hats,
  shown,
  more,
  color,
}: {
  event: string;
  hats: MyHat[];
  shown: number;
  more: number;
  color?: string;
}) {
  const place = (hat: MyHat) =>
    dialogStore.trigger({ component: PlaceHatModal, props: { event, hat, myHats: hats } });
  const tile = clsx(styles.tile, 'relative w-[104px] shrink-0 rounded-[11px]');

  return (
    // Worn on each tile's corner as on a feed card, with the feed card's room past it (36px) once
    // the block is wide enough for four tiles (about 1320px). A narrower block scrolls the row
    // rather than run it under the art: the scroller crops at the column's padding, so the hats get
    // that much room and hold still on hover.
    <div className="mx-[-22px] flex gap-5 overflow-x-auto px-[22px] pt-6 [--event-decoration-allowance:22px] [--event-decoration-grow:1] @[82.5rem]:mx-0 @[82.5rem]:overflow-visible @[82.5rem]:px-0 @[82.5rem]:[--event-decoration-allowance:36px] @[82.5rem]:[--event-decoration-grow:initial]">
      {hats.slice(0, shown).map((hat) => (
        <div
          key={`${hat.cosmeticId}:${hat.claimKey}`}
          className={tile}
          data-testid="event-home-block-hat"
        >
          {hat.placedOn ? (
            <EventContentThumb
              entityType={hat.placedOn.entityType}
              image={hat.placedOn.image}
              hat={hat.data}
              displayWidth={208}
              className="h-[86px] rounded-t-[10px]"
              wornOn={{
                entityType: hat.placedOn.entityType as CosmeticEntity,
                entityId: hat.placedOn.entityId,
              }}
            />
          ) : (
            <div className="relative grid h-[86px] place-items-center rounded-t-[10px] bg-black/25">
              <EdgeMedia
                src={hat.data.url}
                width={96}
                alt=""
                className="-mt-4 w-10 drop-shadow-lg"
              />
              <Button
                size="compact-xs"
                radius="xl"
                leftSection={<IconHanger size={12} />}
                onClick={() => place(hat)}
                className="!absolute bottom-1.5 left-1/2 -translate-x-1/2"
                style={{ background: color, color: '#111' }}
              >
                Place it
              </Button>
            </div>
          )}
          <div className="px-2 pb-1.5 pt-1">
            <Text size="11px" fw={700} truncate title={hat.name}>
              {hat.name}
            </Text>
            <Text size="sm" fw={800} c={hat.placedOn ? color : 'gray.5'}>
              {hat.placedOn ? `+${numberWithCommas(hat.points)}` : 'not on a post'}
            </Text>
          </div>
        </div>
      ))}
      {more > 0 ? (
        <NextLink
          href={`/events/${event}`}
          className={clsx(
            tile,
            'grid place-items-center text-center text-xs font-bold text-white no-underline'
          )}
        >
          +{more} more
        </NextLink>
      ) : (
        shown < HOME_BLOCK_HAT_TILES && (
          // Laid out like a hat tile, a plus for its picture and two short lines for its name and
          // points, so the words fit its width without wrapping.
          <NextLink
            href={`/events/${event}#team-hats`}
            className="flex w-[104px] shrink-0 flex-col rounded-[11px] border-[1.5px] border-dashed border-white/25 text-white no-underline"
            data-testid="event-home-block-get-hat"
          >
            <span className="grid h-[86px] place-items-center border-0 border-b-[1.5px] border-dashed border-white/15">
              <span className="grid size-[34px] place-items-center rounded-full bg-white/10">
                <IconPlus size={20} className="text-gray-4" />
              </span>
            </span>
            <span className="block px-2 pb-1.5 pt-1 text-[11px]">
              <span className="block truncate font-bold">Another hat</span>
              <span className="block truncate font-medium text-gray-5">+1 post scoring</span>
            </span>
          </NextLink>
        )
      )}
    </div>
  );
}
