import { Anchor, Card, Loader, Stack, Text, Title, Tooltip } from '@mantine/core';
import {
  IconArrowRight,
  IconCalendarCheck,
  IconCircleCheck,
  IconLock,
  IconTrendingUp,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { creatorScoreGrowsWhen } from '~/components/Account/creator-score-copy';
import { UserScoreDisplay } from '~/components/Account/UserScoreDisplay';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink } from '~/components/NextLink/NextLink';
import { useSpotlight } from '~/hooks/useSpotlight';
import { CREATOR_SCORE_EXPLAINER_HREF } from '~/shared/constants/creator-journey.constants';
import type {
  CreatorScoreKinds,
  CreatorScoreRung,
  CreatorScoreTier,
} from '~/shared/utils/creator-score-unlocks';
import {
  buildCreatorScoreLadder,
  currentCreatorScoreTier,
  describeCreatorScoreUnlocks,
  groupCreatorScoreUnlocks,
  isCreatorScoreUnlockReached,
  nextCreatorScoreRung,
  pendingCreatorScoreUnlocks,
} from '~/shared/utils/creator-score-unlocks';
import type { RouterOutput } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type Journey = RouterOutput['creatorJourney']['getMine'];
type BadgeState = 'earned' | 'next' | 'locked';

const HEXAGON = 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)';
const DEFAULT_ACCENT = '#f59f00';

// Sampled from each tier's enamel plate, so glows and bars match the art.
const tierAccents: Record<string, string> = {
  'score:spark': '#c92a2a',
  'score:kindle': '#d9480f',
  'score:flame': '#f76707',
  'score:blaze': '#f59f00',
  'score:beacon': '#e8b923',
  'score:nova': '#3b5bdb',
  'score:star': '#4dabf7',
  'score:supernova': '#ae3ec9',
  'score:legend': '#e9c46a',
};

const accentOf = (tier: CreatorScoreTier | null | undefined) =>
  (tier && tierAccents[tier.key]) ?? DEFAULT_ACCENT;

const accentVar = (accent: string) => ({ '--cj-accent': accent } as CSSProperties);

export function CreatorJourney() {
  const { data, isLoading } = trpc.creatorJourney.getMine.useQuery();

  if (isLoading || !data)
    return (
      <div className="flex justify-center py-16">
        <Loader />
      </div>
    );

  return <CreatorJourneyView journey={data} />;
}

export function CreatorJourneyView({ journey }: { journey: Journey }) {
  const kinds: CreatorScoreKinds = {
    total: journey.scores?.total ?? 0,
    aggregate: journey.scores?.aggregate,
  };
  const total = kinds.total;
  const rungs = buildCreatorScoreLadder(journey.unlocks, journey.tiers);
  const next = nextCreatorScoreRung(rungs, total);
  const currentTier = currentCreatorScoreTier(rungs, total);
  const articleUnlocks = journey.unlocks.filter((u) => u.scoreKind === 'articles');
  const nextTier = journey.tiers.find((tier) => tier.threshold > total) ?? null;
  const accent = accentOf(currentTier);

  return (
    <Stack gap="xl">
      <Stack gap={4}>
        <Title order={1}>Your Creator Journey</Title>
        <Text c="dimmed">
          Where your Creator Score stands, what it unlocks next, and the badges you have earned.
          Only you can see this page.
        </Text>
      </Stack>

      <Card
        withBorder
        radius="lg"
        p={0}
        className="relative overflow-hidden"
        style={accentVar(accent)}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-25 dark:opacity-30"
          style={{
            background:
              'radial-gradient(120% 90% at 0% 0%, var(--cj-accent) 0%, transparent 60%), radial-gradient(80% 80% at 100% 100%, var(--cj-accent) 0%, transparent 70%)',
          }}
        />
        <div className="relative flex flex-col gap-6 p-5 sm:p-7">
          <div className="flex flex-col items-center gap-5 text-center sm:flex-row sm:items-center sm:text-left">
            <HeroBadge tier={currentTier ?? nextTier} earned={!!currentTier} />
            <Stack gap={6} className="min-w-0 flex-1">
              <Text size="xs" tt="uppercase" c="dimmed" fw={600} className="tracking-wider">
                Your Creator Score
              </Text>
              <Text fw={800} lh={1} className="text-5xl tabular-nums tracking-tight sm:text-6xl">
                {journey.scores ? numberWithCommas(Math.floor(total)) : '–'}
              </Text>
              {currentTier && (
                <div className="flex justify-center sm:justify-start">
                  <span
                    className="rounded-full px-3 py-1 text-sm font-bold uppercase tracking-wider text-white shadow-sm"
                    style={{ background: 'var(--cj-accent)' }}
                  >
                    {currentTier.name}
                  </span>
                </div>
              )}
            </Stack>
          </div>

          <div className="rounded-lg bg-white/60 p-4 backdrop-blur-sm dark:bg-dark-7/60">
            {!journey.scores ? (
              <Text size="sm" c="dimmed">
                You don&apos;t have a Creator Score yet. It starts when {creatorScoreGrowsWhen}, and
                it updates once a day.
              </Text>
            ) : next ? (
              <NextRung rungs={rungs} next={next} kinds={kinds} />
            ) : (
              <Text size="sm">You have reached every rung on the ladder.</Text>
            )}
          </div>

          {journey.tiers.length > 0 && <BadgeStrip tiers={journey.tiers} total={total} />}
        </div>
      </Card>

      <Stack gap="sm">
        <Title order={2} size="h3">
          The Ladder
        </Title>
        <Stack gap={0}>
          {rungs.map((rung, index) => (
            <LadderRung
              key={rung.tier?.key ?? rung.minScore}
              rung={rung}
              kinds={kinds}
              isNext={rung === next}
              isLast={index === rungs.length - 1}
            />
          ))}
        </Stack>
        {articleUnlocks.length > 0 && (
          <Text size="sm" c="dimmed">
            Daily article limits follow your articles score
            {journey.scores
              ? ` (${numberWithCommas(Math.floor(journey.scores.articles))})`
              : ''}{' '}
            rather than your total:{' '}
            {articleUnlocks
              .map((u) => `${numberWithCommas(u.minScore)}: ${u.label.toLowerCase()}`)
              .join('; ')}
            .
          </Text>
        )}
      </Stack>

      <Stack gap="sm">
        <Title order={2} size="h3">
          Where Your Score Comes From
        </Title>
        <UserScoreDisplay scores={journey.scores?.breakdown} abbreviate={false} />
        <Anchor component={NextLink} href={CREATOR_SCORE_EXPLAINER_HREF} size="sm">
          How Creator Score is earned <IconArrowRight size={14} className="inline" />
        </Anchor>
      </Stack>

      <Stack gap="sm">
        <Title order={2} size="h3">
          Badges Earned
        </Title>
        {journey.earned.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {journey.earned.map((badge) => (
              <EarnedBadgeCard key={badge.key} badge={badge} />
            ))}
          </div>
        ) : (
          <Text size="sm" c="dimmed">
            No badges yet.
            {journey.tiers[0] &&
              ` Your first arrives at ${
                journey.tiers[0].name
              }, a Creator Score of ${numberWithCommas(journey.tiers[0].threshold)}.`}{' '}
            Badges you earn are yours to keep.
          </Text>
        )}
      </Stack>
    </Stack>
  );
}

function EarnedBadgeCard({ badge }: { badge: Journey['earned'][number] }) {
  const accent = tierAccents[badge.key] ?? DEFAULT_ACCENT;
  const { spotlightRef, handleMouseMove, handleMouseLeave } = useSpotlight({
    size: 240,
    color: `color-mix(in srgb, ${accent} 30%, transparent)`,
  });

  return (
    <Card
      withBorder
      radius="md"
      p="md"
      className="relative flex flex-col items-center gap-2 overflow-hidden text-center"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={accentVar(accent)}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-20"
        style={{
          background: 'radial-gradient(60% 100% at 50% 0%, var(--cj-accent) 0%, transparent 100%)',
        }}
      />
      <div
        ref={spotlightRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500"
      />
      <TierBadge name={badge.name} badgeUrl={badge.badgeUrl} state="earned" size={72} />
      <Text fw={800} size="lg" lh={1.2}>
        {badge.name}
      </Text>
      {badge.track === 'score' && badge.threshold != null ? (
        <div className="flex flex-col items-center">
          <div className="flex items-center gap-1">
            <IconTrendingUp size={16} className="shrink-0 text-[var(--cj-accent)]" />
            <Text fw={700} className="tabular-nums">
              {numberWithCommas(badge.threshold)}
            </Text>
          </div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} className="tracking-wide">
            Creator Score
          </Text>
        </div>
      ) : (
        badge.description && (
          <Text size="xs" c="dimmed">
            {badge.description}
          </Text>
        )
      )}
      <div className="mt-auto flex w-full items-center justify-center gap-1.5 border-0 border-t border-solid border-gray-2 pt-2 dark:border-dark-4">
        <IconCalendarCheck size={14} className="shrink-0 text-gray-6 dark:text-dark-2" />
        <Text size="xs" c="dimmed">
          Earned {formatDate(badge.achievedAt)}
        </Text>
      </div>
    </Card>
  );
}

function TierBadge({
  name,
  badgeUrl,
  state,
  size,
  fluid,
  className,
}: {
  name: string;
  badgeUrl?: string | null;
  state: BadgeState;
  size: number;
  /** Shrink to the container's width, up to `size`. */
  fluid?: boolean;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'relative flex shrink-0 items-center justify-center transition-all',
        state === 'locked' && 'opacity-40 grayscale',
        state === 'next' && 'opacity-80 grayscale-[60%]',
        className
      )}
      style={{
        ...(fluid
          ? { width: '100%', maxWidth: size, aspectRatio: '1' }
          : { width: size, height: size }),
        filter:
          state === 'earned'
            ? 'drop-shadow(0 4px 10px color-mix(in srgb, var(--cj-accent) 55%, transparent))'
            : undefined,
      }}
    >
      {badgeUrl ? (
        <EdgeMedia
          src={badgeUrl}
          alt={name}
          width={size * 2}
          className="size-full object-contain"
          optimized
        />
      ) : (
        <div
          className="flex size-full items-center justify-center bg-gray-3 font-bold text-gray-7 dark:bg-dark-4 dark:text-dark-0"
          style={{ clipPath: HEXAGON, fontSize: size * 0.32 }}
        >
          {name.slice(0, 1)}
        </div>
      )}
      {state !== 'earned' && size >= 40 && (
        <span
          className={clsx(
            'absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-gray-6 text-white dark:bg-dark-3',
            fluid ? 'size-4' : 'size-5'
          )}
        >
          <IconLock size={fluid ? 10 : 12} />
        </span>
      )}
    </div>
  );
}

function HeroBadge({ tier, earned }: { tier: CreatorScoreTier | null; earned: boolean }) {
  if (!tier) return null;
  return (
    <div className="relative shrink-0" style={accentVar(accentOf(tier))}>
      {earned && (
        <div
          aria-hidden
          className="absolute inset-0 scale-125 rounded-full opacity-50 blur-2xl motion-safe:animate-pulse"
          style={{ background: 'var(--cj-accent)' }}
        />
      )}
      <TierBadge
        name={tier.name}
        badgeUrl={tier.badgeUrl}
        state={earned ? 'earned' : 'locked'}
        size={144}
        className="relative"
      />
    </div>
  );
}

function BadgeStrip({ tiers, total }: { tiers: CreatorScoreTier[]; total: number }) {
  const earnedCount = tiers.filter((tier) => tier.threshold <= total).length;
  const nextKey = tiers.find((tier) => tier.threshold > total)?.key;

  return (
    <div className="flex flex-col gap-2">
      <Text size="xs" tt="uppercase" c="dimmed" fw={600} className="tracking-wider">
        {earnedCount} of {tiers.length} tier badges
      </Text>
      <div className="grid grid-cols-9 gap-1">
        {tiers.map((tier) => {
          const state: BadgeState =
            tier.threshold <= total ? 'earned' : tier.key === nextKey ? 'next' : 'locked';
          return (
            <Tooltip
              key={tier.key}
              label={`${tier.name} · ${numberWithCommas(tier.threshold)}`}
              withArrow
              withinPortal
            >
              <div
                className={clsx(
                  'flex w-full min-w-0 max-w-[52px] justify-center justify-self-center rounded-md p-0.5 sm:p-1',
                  state === 'next' && 'bg-white/70 ring-2 ring-[var(--cj-accent)] dark:bg-dark-6'
                )}
                style={accentVar(accentOf(tier))}
              >
                <TierBadge
                  name={tier.name}
                  badgeUrl={tier.badgeUrl}
                  state={state}
                  size={44}
                  fluid
                />
              </div>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function rungName(rung: CreatorScoreRung) {
  return rung.tier?.name ?? `A Creator Score of ${numberWithCommas(rung.minScore)}`;
}

function NextRung({
  rungs,
  next,
  kinds,
}: {
  rungs: CreatorScoreRung[];
  next: CreatorScoreRung;
  kinds: CreatorScoreKinds;
}) {
  const { total } = kinds;
  const index = rungs.indexOf(next);
  const floor = index > 0 ? rungs[index - 1].minScore : 0;
  const progress = Math.min(Math.max(((total - floor) / (next.minScore - floor)) * 100, 0), 100);
  const pending = pendingCreatorScoreUnlocks(next, kinds);
  const fromAccent = index > 0 ? accentOf(rungs[index - 1].tier) : DEFAULT_ACCENT;
  const toAccent = accentOf(next.tier);

  return (
    <div className="flex items-center gap-4">
      <Stack gap={6} className="min-w-0 flex-1">
        <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
          Next: {next.tier ? `${next.tier.name} at ` : ''}
          {numberWithCommas(next.minScore)}
        </Text>
        <div
          role="progressbar"
          aria-label="Progress to the next rung"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          className="h-3 overflow-hidden rounded-full bg-gray-2 dark:bg-dark-5"
        >
          <div
            className="h-full rounded-full transition-[width] duration-700"
            style={{
              width: `${progress}%`,
              background: `linear-gradient(90deg, ${fromAccent}, ${toAccent})`,
              boxShadow: `0 0 12px ${toAccent}`,
            }}
          />
        </div>
        <Text size="sm" c="dimmed">
          {numberWithCommas(Math.ceil(next.minScore - total))} to go.
          {pending.length > 0 && ` Unlocks: ${describeCreatorScoreUnlocks(pending)}.`}
        </Text>
      </Stack>
      {next.tier && (
        <div style={accentVar(toAccent)}>
          <TierBadge name={next.tier.name} badgeUrl={next.tier.badgeUrl} state="next" size={64} />
        </div>
      )}
    </div>
  );
}

function LadderRung({
  rung,
  kinds,
  isNext,
  isLast,
}: {
  rung: CreatorScoreRung;
  kinds: CreatorScoreKinds;
  isNext: boolean;
  isLast: boolean;
}) {
  const reached = kinds.total >= rung.minScore;
  const accent = accentOf(rung.tier);
  const state: BadgeState = reached ? 'earned' : isNext ? 'next' : 'locked';

  return (
    <div className="flex gap-3 sm:gap-4" style={accentVar(accent)}>
      <div className="flex w-14 shrink-0 flex-col items-center">
        {rung.tier ? (
          <TierBadge name={rung.tier.name} badgeUrl={rung.tier.badgeUrl} state={state} size={56} />
        ) : (
          <div className="flex h-14 items-center">
            <div
              className={clsx(
                'size-4 rounded-full border-2',
                reached
                  ? 'border-[var(--cj-accent)] bg-[var(--cj-accent)]'
                  : 'border-gray-4 dark:border-dark-3'
              )}
            />
          </div>
        )}
        {!isLast && (
          <div
            className={clsx('my-1 w-1 flex-1 rounded-full', !reached && 'bg-gray-3 dark:bg-dark-4')}
            style={
              reached
                ? { background: 'linear-gradient(var(--cj-accent), transparent 140%)' }
                : undefined
            }
          />
        )}
      </div>
      <div
        className={clsx(
          'mb-4 min-w-0 flex-1 rounded-lg px-3 py-2',
          isNext && 'border-2 border-solid'
        )}
        style={
          isNext
            ? {
                borderColor: 'var(--cj-accent)',
                background: 'color-mix(in srgb, var(--cj-accent) 8%, transparent)',
              }
            : undefined
        }
      >
        <div className="flex flex-wrap items-baseline gap-x-3">
          <Text
            fw={700}
            size={rung.tier ? 'lg' : 'md'}
            c={reached || isNext ? undefined : 'dimmed'}
          >
            {rungName(rung)}
          </Text>
          {rung.tier && (
            <Text size="sm" c="dimmed" className="tabular-nums">
              {numberWithCommas(rung.minScore)}
            </Text>
          )}
          {isNext && (
            <span
              className="rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-white"
              style={{ background: 'var(--cj-accent)' }}
            >
              Next
            </span>
          )}
        </div>
        {rung.tier?.hint && !reached && (
          <Text size="sm" c="dimmed" fs="italic">
            {rung.tier.hint}
          </Text>
        )}
        {rung.unlocks.length > 0 ? (
          <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {groupCreatorScoreUnlocks(rung.unlocks).map((group) => {
              const unlocked = group.unlocks.every((u) => isCreatorScoreUnlockReached(u, kinds));
              return (
                <li key={group.key} className="flex items-start gap-2">
                  {unlocked ? (
                    <IconCircleCheck size={16} className="mt-0.5 shrink-0 text-green-6" />
                  ) : (
                    <IconLock size={16} className="mt-0.5 shrink-0 text-gray-5" />
                  )}
                  <Text size="sm" c={unlocked ? undefined : 'dimmed'}>
                    {group.label}
                    {group.minScore !== rung.minScore &&
                      ` (from ${numberWithCommas(group.minScore)})`}
                  </Text>
                </li>
              );
            })}
          </ul>
        ) : (
          <Text size="sm" c="dimmed">
            Recognition only. Nothing new unlocks here.
          </Text>
        )}
      </div>
    </div>
  );
}
