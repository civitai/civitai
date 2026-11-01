import { Paper, Text, UnstyledButton } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { memo, useEffect } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import type { RosterModalHat } from '~/components/Events/ScoredEvent/roster/RosterHatsModal';
import RosterHatsModal from '~/components/Events/ScoredEvent/roster/RosterHatsModal';
import type { RosterSort } from '~/components/Events/ScoredEvent/roster/roster-cards.utils';
import {
  daysOnTeam,
  GOLD_TIER,
  hatTier,
  isNewMember,
  podiumHero,
  slotPlan,
} from '~/components/Events/ScoredEvent/roster/roster-cards.utils';
import { EVENT_CARD_SURFACE } from '~/components/Events/ScoredEvent/scored-event.utils';
import { AnimatedCount } from '~/components/Metrics/AnimatedCount';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useInView } from '~/hooks/useInView';
import type { RouterOutput } from '~/types/router';

export type RosterItem = RouterOutput['event']['getTeamRoster']['items'][number];
type CardHat = RosterModalHat & { price: number | null };

/** What every card needs besides its member: the team, its colours, and the page's context. */
export type RosterCardContext = {
  team: string;
  /** Identity colour: dot, name, border, underline, Wearing tag. */
  color?: string;
  /** Glow and tint colour, a step brighter than the identity colour. */
  glow: string;
  sort: RosterSort;
  prices: number[];
  now: Date;
  /** When the event opened: earlier joiners show as joining then. */
  startDate?: Date;
  onVisible: (topicId: string, inView: boolean) => void;
};

// Shelf slots by the card's own width (two rows): 4 a row below 300px, 5 at and above.
const SHELF_SLOTS = { narrow: 8, wide: 10 };
// Podium mini row: 6 slots on a card 220px or wider, 4 below.
const MINI_SLOTS = { narrow: 4, wide: 6 };

const MEDALS: Record<number, { background: string; color: string }> = {
  1: { background: 'linear-gradient(135deg, #ffe066, #f59f00)', color: '#2b1d00' },
  2: { background: 'linear-gradient(135deg, #f1f3f5, #adb5bd)', color: '#212529' },
  3: { background: 'linear-gradient(135deg, #f4a261, #b5651d)', color: '#2a1300' },
};

// The podium hero: wider than tall, so the three cards stay a card's height, not a poster's.
const HERO = '!aspect-[5/4]';

// The podium's foil: the shop's top-tier tile border (EventHatTile tierStyle), team colour and gold.
function foilStyle(color: string): CSSProperties {
  return {
    border: '2px solid transparent',
    background: `linear-gradient(var(--card-bg), var(--card-bg)) padding-box, linear-gradient(135deg, ${color}, #fcc419, ${color}) border-box`,
    boxShadow: `0 0 22px -6px ${color}`,
  };
}

function cardHats(item: RosterItem): CardHat[] {
  return item.hats.flatMap((h) => (h.url ? [{ ...h, url: h.url }] : []));
}

function openHats(item: RosterItem, ctx: RosterCardContext) {
  dialogStore.trigger({
    component: RosterHatsModal,
    props: {
      username: item.user.username ?? 'Member',
      hats: cardHats(item),
      color: ctx.color,
      glow: ctx.glow,
    },
  });
}

/** Follows the card's live total while it is on screen (event-points-live.tsx). */
function useLiveWhileVisible(topicId: string, onVisible: RosterCardContext['onVisible']) {
  const { ref, inView } = useInView();
  useEffect(() => {
    onVisible(topicId, inView);
    return () => onVisible(topicId, false);
  }, [topicId, inView, onVisible]);
  return { ref, inView };
}

export function RankChip({ rank, className }: { rank: number; className?: string }) {
  const medal = MEDALS[rank];
  return (
    <span
      className={clsx(
        'inline-flex h-[30px] min-w-[38px] items-center justify-center rounded-full px-2 text-sm font-extrabold tabular-nums',
        !medal && 'border border-solid border-dark-4 bg-dark-5 text-white',
        className
      )}
      style={medal}
      data-testid="roster-rank"
    >
      <span className="opacity-55">#</span>
      {rank}
    </span>
  );
}

export function NewBadge({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[10.5px] font-extrabold uppercase leading-4 text-[#1a1b1e]',
        className
      )}
      style={{
        background: 'linear-gradient(135deg, #96f2d7, #74c0fc)',
        boxShadow: '0 0 10px -2px rgba(116, 192, 252, 0.6)',
      }}
      data-testid="roster-new"
    >
      <IconSparkles size={12} />
      New
    </span>
  );
}

/** The member's avatar with the hat they wear perched on its corner. */
function WearingAvatar({
  item,
  size,
  hatUrl,
}: {
  item: RosterItem;
  size: number;
  hatUrl?: string;
}) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <UserAvatar user={item.user} avatarSize={size} withDecorations={false} linkToProfile />
      {hatUrl && (
        <EdgeMedia
          src={hatUrl}
          width={Math.round(size * 1.6)}
          alt=""
          loading="lazy"
          className="pointer-events-none absolute drop-shadow-[0_3px_4px_rgba(0,0,0,0.45)]"
          style={{ width: '78%', top: '-52%', right: '-26%', transform: 'rotate(14deg)' }}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  active,
  color,
  children,
}: {
  label: string;
  active: boolean;
  color?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-col items-center gap-0.5 py-1.5"
      data-active={active || undefined}
    >
      <span
        className="text-base font-extrabold tabular-nums leading-5"
        style={active ? { boxShadow: `inset 0 -2px 0 ${color ?? 'currentColor'}` } : undefined}
      >
        {children}
      </span>
      <Text size="10px" c="dimmed" tt="uppercase" fw={700} lts={0.4}>
        {label}
      </Text>
    </div>
  );
}

function Stats({
  item,
  ctx,
  inView,
}: {
  item: RosterItem;
  ctx: RosterCardContext;
  /** Counts roll only on screen (AnimatedCount's cost is per element). */
  inView: boolean;
}) {
  const days = daysOnTeam(item.joinedAt, ctx.now, ctx.startDate);
  return (
    <div
      className="grid grid-cols-3 rounded-md bg-gray-1 dark:bg-dark-8"
      data-testid="roster-stats"
    >
      <Stat
        label={item.hatCount === 1 ? 'hat' : 'hats'}
        active={ctx.sort === 'hats'}
        color={ctx.color}
      >
        <AnimatedCount
          value={item.hatCount}
          abbreviate={false}
          resetKey={item.user.id}
          animate={inView}
        />
      </Stat>
      <Stat label="points" active={ctx.sort === 'points'} color={ctx.color}>
        <AnimatedCount
          value={item.points}
          abbreviate={false}
          resetKey={item.user.id}
          animate={inView}
        />
      </Stat>
      <Stat
        label={days === 1 ? 'day on team' : 'days on team'}
        active={ctx.sort === 'newest'}
        color={ctx.color}
      >
        {days}
      </Stat>
    </div>
  );
}

function MoreTile({
  more,
  onClick,
  className,
}: {
  more: number;
  onClick: () => void;
  className?: string;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      aria-label={`See all ${more} more hats`}
      className={clsx(
        'aspect-square w-full place-items-center rounded-md bg-gray-2 text-sm font-extrabold tabular-nums dark:bg-dark-5',
        className
      )}
      data-testid="roster-more"
    >
      +{more}
    </UnstyledButton>
  );
}

/**
 * A row of hat tiles that fits the card: every hat when they fit, otherwise one slot fewer and a
 * "+N" for the rest. The slot count follows the card's own width (a container query), so both plans
 * are drawn and CSS shows the one that fits.
 */
function HatRow({
  hats,
  slots,
  breakpoint,
  cols,
  ctx,
  onMore,
  tagWorn,
}: {
  hats: CardHat[];
  slots: { narrow: number; wide: number };
  /** Container class prefix for the wide plan, e.g. `@[300px]:`. */
  breakpoint: { show: string; showGrid: string; hide: string; grid: string };
  cols: string;
  ctx: RosterCardContext;
  onMore: () => void;
  tagWorn?: boolean;
}) {
  const narrow = slotPlan(hats.length, slots.narrow);
  const wide = slotPlan(hats.length, slots.wide);
  return (
    <div className={clsx('grid gap-1.5', cols, breakpoint.grid)} data-testid="roster-hat-row">
      {hats.slice(0, Math.max(narrow.shown, wide.shown)).map((hat, i) => {
        const tier = hatTier(hat.price, ctx.prices);
        return (
          <div
            key={`${hat.cosmeticId}-${i}`}
            className={clsx('relative', i >= narrow.shown && clsx('hidden', breakpoint.show))}
            data-testid="roster-hat"
            data-narrow={i < narrow.shown || undefined}
            data-tier={tier}
          >
            <HatArt url={hat.url} color={ctx.glow} width={96} />
            {tier >= GOLD_TIER && (
              <span
                className="absolute right-1 top-1 size-1.5 rounded-full bg-[#fcc419] shadow-[0_0_4px_#fcc419]"
                aria-hidden
              />
            )}
            {tagWorn && hat.worn && (
              <span
                className="absolute inset-x-0 bottom-0 rounded-b-md py-px text-center text-[9px] font-extrabold uppercase text-white"
                style={{ background: ctx.color }}
              >
                Wearing
              </span>
            )}
          </div>
        );
      })}
      {narrow.more > 0 && (
        <MoreTile more={narrow.more} onClick={onMore} className={clsx('grid', breakpoint.hide)} />
      )}
      {wide.more > 0 && (
        <MoreTile
          more={wide.more}
          onClick={onMore}
          className={clsx('hidden', breakpoint.showGrid)}
        />
      )}
    </div>
  );
}

function Username({
  item,
  ctx,
  extra,
}: {
  item: RosterItem;
  ctx: RosterCardContext;
  extra?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <Text fw={800} truncate>
        {item.user.username}
      </Text>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="size-2 shrink-0 rounded-full" style={{ background: ctx.color }} />
        <Text size="xs" fw={700} c={ctx.color} truncate>
          Team {ctx.team}
        </Text>
        {extra}
      </div>
    </div>
  );
}

/** Direction A: a member's card in the grid, their hats on a two-row shelf. */
export const RosterShelfCard = memo(function RosterShelfCard({
  item,
  rank,
  ctx,
}: {
  item: RosterItem;
  rank: number;
  ctx: RosterCardContext;
}) {
  const { ref, inView } = useLiveWhileVisible(item.topicId, ctx.onVisible);
  const hats = cardHats(item);
  const worn = hats.find((h) => h.worn);
  const isNew = isNewMember(item.joinedAt, ctx.now, ctx.startDate);

  return (
    <Paper
      ref={ref}
      withBorder
      radius="md"
      className={clsx('relative overflow-hidden @container', EVENT_CARD_SURFACE)}
      style={{ borderColor: ctx.color }}
      data-testid="roster-card"
    >
      <div
        className="h-[54px]"
        style={{
          background: `linear-gradient(180deg, color-mix(in srgb, ${ctx.glow} 30%, transparent), transparent)`,
          borderTop: `3px solid ${ctx.color}`,
        }}
      />
      <RankChip rank={rank} className="absolute right-3 top-3" />
      <div className="-mt-7 flex flex-col gap-3 px-3 pb-3">
        <div className="flex items-end gap-3">
          <WearingAvatar item={item} size={56} hatUrl={worn?.url} />
          <Username item={item} ctx={ctx} extra={isNew && <NewBadge />} />
        </div>
        {/* The score sits at the same height on every card; the shelf below varies. */}
        <Stats item={item} ctx={ctx} inView={inView} />
        {hats.length ? (
          <HatRow
            hats={hats}
            slots={SHELF_SLOTS}
            cols="grid-cols-[repeat(4,minmax(0,1fr))]"
            breakpoint={{
              grid: '@[300px]:grid-cols-[repeat(5,minmax(0,1fr))]',
              show: '@[300px]:block',
              showGrid: '@[300px]:grid',
              hide: '@[300px]:hidden',
            }}
            ctx={ctx}
            onMore={() => openHats(item, ctx)}
            tagWorn
          />
        ) : (
          <div
            className="rounded-md border border-dashed border-gray-4 py-5 text-center dark:border-dark-4"
            data-testid="roster-no-hats"
          >
            <Text size="sm" c="dimmed">
              No hats yet
            </Text>
          </div>
        )}
      </div>
    </Paper>
  );
});

/** Direction C: a top-three member as a trading card, their worn hat as the hero. */
export const RosterPodiumCard = memo(function RosterPodiumCard({
  item,
  rank,
  ctx,
  teamHatUrl,
  className,
}: {
  item: RosterItem;
  rank: number;
  ctx: RosterCardContext;
  /** The team's join hat, ghosted for a member with no hat yet. */
  teamHatUrl?: string | null;
  className?: string;
}) {
  const { ref, inView } = useLiveWhileVisible(item.topicId, ctx.onVisible);
  const { hero, label, rest } = podiumHero(cardHats(item));
  const isNew = isNewMember(item.joinedAt, ctx.now, ctx.startDate);

  return (
    <div
      ref={ref}
      className={clsx(
        'flex flex-col gap-3 rounded-lg p-3 @container [--card-bg:white] dark:[--card-bg:var(--mantine-color-dark-6)]',
        className
      )}
      style={foilStyle(ctx.color ?? ctx.glow)}
      data-testid="roster-podium-card"
    >
      <div className="relative">
        {hero ? (
          <HatArt url={hero.url} color={ctx.glow} width={256} className={HERO} />
        ) : teamHatUrl ? (
          <HatArt url={teamHatUrl} className={clsx(HERO, 'opacity-30 grayscale')} width={256} />
        ) : (
          <div className={clsx(HERO, 'w-full rounded-md bg-gray-1 dark:bg-dark-7')} />
        )}
        <RankChip rank={rank} className="absolute left-2 top-2 shadow-md" />
        {isNew && <NewBadge className="absolute right-2 top-2 rotate-6 px-2 py-0.5 text-xs" />}
        <Text
          size="xs"
          fw={700}
          truncate
          className="absolute bottom-2 left-1/2 max-w-[calc(100%-16px)] -translate-x-1/2 rounded-full bg-black/60 px-3 py-0.5 text-white"
          data-testid="roster-hero-label"
        >
          {label === 'wearing'
            ? `Wearing · ${hero?.name}`
            : label === 'top'
            ? `Top hat · ${hero?.name}`
            : 'No hat yet'}
        </Text>
      </div>
      <div className="flex items-center gap-2">
        <UserAvatar user={item.user} avatarSize={36} withDecorations={false} linkToProfile />
        <Username item={item} ctx={ctx} />
      </div>
      <Stats item={item} ctx={ctx} inView={inView} />
      {rest.length > 0 && (
        <HatRow
          hats={rest}
          slots={MINI_SLOTS}
          cols="grid-cols-[repeat(4,minmax(0,1fr))]"
          breakpoint={{
            grid: '@[220px]:grid-cols-[repeat(6,minmax(0,1fr))]',
            show: '@[220px]:block',
            showGrid: '@[220px]:grid',
            hide: '@[220px]:hidden',
          }}
          ctx={ctx}
          onMore={() => openHats(item, ctx)}
        />
      )}
    </div>
  );
});
