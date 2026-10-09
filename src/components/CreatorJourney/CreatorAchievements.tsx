import { Stack, Text, Title } from '@mantine/core';
import clsx from 'clsx';
import { LinkedText } from '~/components/CreatorJourney/journey-links';
import { accentVar, HEXAGON, TierBadge } from '~/components/CreatorJourney/tier-badge';
import {
  SpotlightBorderCard,
  SpotlightDivider,
} from '~/components/SpotlightCard/SpotlightBorderCard';
import type { RouterOutput } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';

type Activity = RouterOutput['creatorJourney']['getMine']['activity'];
type Milestone = Activity['milestones'][number];
type Measure = Milestone['measure'];

const tracks = [
  { key: 'create', title: 'Create', accent: '#12b886', measures: ['models', 'articles'] },
  {
    key: 'reach',
    title: 'Reach',
    accent: '#f59f00',
    measures: ['downloads', 'followers', 'reactions'],
  },
  { key: 'earn', title: 'Earn', accent: '#7950f2', measures: ['revenue'] },
  { key: 'community', title: 'Community', accent: '#228be6', measures: ['votes'] },
] as const satisfies ReadonlyArray<{
  key: string;
  title: string;
  accent: string;
  measures: readonly Measure[];
}>;

const measureCopy: Record<
  Measure,
  { label: string; current: (n: number) => string; unit: string }
> = {
  models: { label: 'Models', current: (n) => `${numberWithCommas(n)} published`, unit: 'models' },
  articles: {
    label: 'Articles',
    current: (n) => `${numberWithCommas(n)} published`,
    unit: 'articles',
  },
  downloads: {
    label: 'Downloads',
    current: (n) => `top model ${numberWithCommas(n)}`,
    unit: 'downloads on one model',
  },
  followers: { label: 'Followers', current: (n) => numberWithCommas(n), unit: 'followers' },
  reactions: { label: 'Reactions', current: (n) => numberWithCommas(n), unit: 'reactions' },
  revenue: {
    label: 'Sales',
    current: (n) => `${numberWithCommas(n)} Buzz`,
    unit: 'Buzz in shop sales',
  },
  votes: {
    label: 'Crucible votes',
    current: (n) => `${numberWithCommas(n)} cast`,
    unit: 'votes',
  },
};

/** Where a measure's work happens. Followers, downloads and reactions have no page of their own. */
export function measureHref(measure: Measure, username?: string) {
  if (measure === 'votes') return '/crucibles';
  if (!username) return undefined;
  if (measure === 'models') return `/user/${username}/models`;
  if (measure === 'articles') return `/user/${username}/articles`;
  if (measure === 'revenue') return `/user/${username}/shop`;
  return undefined;
}

const accentOf = (measure: Measure) =>
  tracks.find((track) => (track.measures as readonly Measure[]).includes(measure))?.accent ??
  tracks[0].accent;

export function earnedLabel(achievedAt: Date | null) {
  return achievedAt ? `Earned ${formatDate(achievedAt)}` : 'Earned';
}

export function CreatorAchievements({
  activity,
  username,
}: {
  activity: Activity;
  username?: string;
}) {
  if (activity.milestones.length === 0) return null;
  const { closestNext } = activity;

  return (
    <Stack gap="sm">
      <Title order={2} size="h3">
        Achievements
      </Title>
      {closestNext && <ClosestNext milestone={closestNext} />}
      {tracks.map((track, index) => (
        <Stack key={track.key} gap="xs" style={accentVar(track.accent)}>
          {index > 0 && <SpotlightDivider className="my-1" />}
          <Text size="xs" tt="uppercase" c="dimmed" fw={700} className="tracking-wider">
            {track.title}
          </Text>
          {track.measures.map((measure) => (
            <MeasureRow
              key={measure}
              measure={measure}
              milestones={activity.milestones.filter((m) => m.measure === measure)}
              next={nextOf(activity.milestones, measure)}
              href={measureHref(measure, username)}
            />
          ))}
        </Stack>
      ))}
    </Stack>
  );
}

function nextOf(milestones: Milestone[], measure: Measure) {
  return milestones.find((m) => m.measure === measure && !m.earned && m.current < m.threshold);
}

function ClosestNext({ milestone }: { milestone: Milestone }) {
  const accent = accentOf(milestone.measure);
  const copy = measureCopy[milestone.measure];
  const remaining = milestone.threshold - milestone.current;

  return (
    <SpotlightBorderCard
      color={accent}
      style={accentVar(accent)}
      faceClassName="flex items-center gap-4 p-4"
    >
      <MilestoneBadge milestone={milestone} state="progress" size={72} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Text size="xs" tt="uppercase" fw={700} className="tracking-wider text-[var(--cj-accent)]">
          Closest next
        </Text>
        <Text fw={800} size="xl" className="tabular-nums" lh={1.1}>
          {numberWithCommas(milestone.current)}{' '}
          <Text span fw={600} size="md" c="dimmed">
            / {numberWithCommas(milestone.threshold)} {copy.unit}
          </Text>
        </Text>
        <ProgressBar current={milestone.current} threshold={milestone.threshold} />
        <Text size="sm" c="dimmed">
          {numberWithCommas(remaining)} more for <b>{milestone.name}</b>.
        </Text>
      </div>
    </SpotlightBorderCard>
  );
}

function MeasureRow({
  measure,
  milestones,
  next,
  href,
}: {
  measure: Measure;
  milestones: Milestone[];
  next: Milestone | undefined;
  href?: string;
}) {
  if (milestones.length === 0) return null;
  const copy = measureCopy[measure];

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[96px_1fr] sm:gap-3">
      <div className="sm:pt-2">
        <Text size="sm" fw={600}>
          {href ? <LinkedText text={copy.label} links={[{ href }]} /> : copy.label}
        </Text>
        <Text size="xs" c="dimmed" className="tabular-nums">
          {copy.current(milestones[0].current)}
        </Text>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {milestones.map((milestone) => (
          <MilestoneTile
            key={milestone.key}
            milestone={milestone}
            state={milestone.earned ? 'earned' : milestone === next ? 'progress' : 'locked'}
          />
        ))}
      </div>
    </div>
  );
}

type TileState = 'earned' | 'progress' | 'locked';

function MilestoneTile({ milestone, state }: { milestone: Milestone; state: TileState }) {
  const copy = measureCopy[milestone.measure];
  return (
    <div
      data-state={state}
      className={clsx(
        'flex min-w-0 items-center gap-2.5 rounded-md border border-solid bg-white p-2.5 dark:bg-dark-6',
        state === 'earned'
          ? 'border-[color-mix(in_srgb,var(--cj-accent)_45%,transparent)]'
          : 'border-gray-3 dark:border-dark-4',
        state === 'locked' && 'opacity-60'
      )}
    >
      <MilestoneBadge milestone={milestone} state={state} size={48} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Text size="sm" fw={700} truncate>
          {milestone.name}
        </Text>
        <Text size="xs" c="dimmed" className="tabular-nums">
          {state === 'earned'
            ? earnedLabel(milestone.achievedAt)
            : state === 'progress'
            ? `${numberWithCommas(milestone.current)} / ${numberWithCommas(milestone.threshold)}`
            : `${numberWithCommas(milestone.threshold)} ${copy.unit}`}
        </Text>
        {state === 'progress' && (
          <ProgressBar current={milestone.current} threshold={milestone.threshold} thin />
        )}
      </div>
    </div>
  );
}

function MilestoneBadge({
  milestone,
  state,
  size,
}: {
  milestone: Milestone;
  state: TileState;
  size: number;
}) {
  if (!milestone.badgeUrl)
    return <Hexagon label={abbreviateNumber(milestone.threshold)} state={state} size={size} />;
  return (
    <TierBadge
      name={milestone.name}
      badgeUrl={milestone.badgeUrl}
      state={state === 'progress' ? 'next' : state}
      size={size}
    />
  );
}

export function Hexagon({ label, state, size }: { label: string; state: TileState; size: number }) {
  return (
    <div
      aria-hidden
      className={clsx(
        'flex shrink-0 items-center justify-center font-extrabold',
        state === 'locked' && 'bg-gray-3 text-gray-6 dark:bg-dark-4 dark:text-dark-2'
      )}
      style={{
        width: size,
        height: size,
        clipPath: HEXAGON,
        fontSize: size * 0.32,
        ...(state === 'earned' && { background: 'var(--cj-accent)', color: 'white' }),
        ...(state === 'progress' && {
          background: 'color-mix(in srgb, var(--cj-accent) 30%, transparent)',
        }),
      }}
    >
      {label}
    </div>
  );
}

function ProgressBar({
  current,
  threshold,
  thin,
}: {
  current: number;
  threshold: number;
  thin?: boolean;
}) {
  const percent = Math.min(Math.max((current / threshold) * 100, 0), 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={threshold}
      aria-valuenow={current}
      className={clsx(
        'overflow-hidden rounded-full bg-gray-2 dark:bg-dark-5',
        thin ? 'h-1' : 'h-2'
      )}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${percent}%`, background: 'var(--cj-accent)' }}
      />
    </div>
  );
}
