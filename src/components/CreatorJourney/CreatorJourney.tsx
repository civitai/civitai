import { Anchor, Card, Collapse, Loader, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconArrowRight, IconChevronDown, IconCircleCheck, IconLock } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useDisclosure } from '@mantine/hooks';
import { creatorScoreGrowsWhen } from '~/components/Account/creator-score-copy';
import { CreatorScoreExplainer } from '~/components/Account/CreatorScoreExplainer';
import { UserScoreDisplay } from '~/components/Account/UserScoreDisplay';
import { sortEarnedBadges } from '~/components/CreatorJourney/badge-order';
import { CreatorAchievements } from '~/components/CreatorJourney/CreatorAchievements';
import { CreatorSecrets } from '~/components/CreatorJourney/CreatorSecrets';
import {
  LinkedText,
  rewardLinks,
  unlockLinksDownLadder,
  type PhraseLink,
} from '~/components/CreatorJourney/journey-links';
import { EarnedBadgeCard } from '~/components/CreatorJourney/EarnedBadgeCard';
import { TierShareButton } from '~/components/CreatorJourney/TierShareButton';
import { NextLink } from '~/components/NextLink/NextLink';
import { tierRewards } from '~/components/CreatorJourney/tier-rewards';
import type { BadgeState } from '~/components/CreatorJourney/tier-badge';
import {
  accentVar,
  DEFAULT_ACCENT,
  TierBadge,
  tierAccents,
} from '~/components/CreatorJourney/tier-badge';
import {
  CREATOR_SHOWCASE_HREF,
  scoreTierSlugFromKey,
} from '~/shared/constants/creator-journey.constants';
import { useCurrentUser } from '~/hooks/useCurrentUser';
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
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type Journey = RouterOutput['creatorJourney']['getMine'];
// The page container is wide so five-rung ladders fit; the score sections keep the md width.
const scoreSectionWidth =
  'mx-auto w-full max-w-[calc(var(--container-size-md)_-_2*var(--mantine-spacing-md))]';
const accentOf = (tier: CreatorScoreTier | null | undefined) =>
  (tier && tierAccents[tier.key]) ?? DEFAULT_ACCENT;

export function CreatorJourney() {
  const { data, isLoading } = trpc.creatorJourney.getMine.useQuery();
  const currentUser = useCurrentUser();

  if (isLoading || !data)
    return (
      <div className="flex justify-center py-16">
        <Loader />
      </div>
    );

  return <CreatorJourneyView journey={data} username={currentUser?.username ?? undefined} />;
}

export function CreatorJourneyView({ journey, username }: { journey: Journey; username?: string }) {
  const kinds: CreatorScoreKinds = {
    total: journey.scores?.total ?? 0,
    aggregate: journey.scores?.aggregate,
  };
  const total = kinds.total;
  const rungs = buildCreatorScoreLadder(journey.unlocks, journey.tiers);
  const ladderLinks = ladderUnlockLinks(rungs);
  const next = nextCreatorScoreRung(rungs, total);
  const currentTier = currentCreatorScoreTier(rungs, total);
  // Unlocks between tiers fold into the higher tier's rung, so the next rung is unnamed only past the top tier.
  const nextTier = next?.tier ?? null;
  // A badge is earned when it is granted, not when the score crosses its threshold: granting runs in
  // a job, and a hidden tier stays masked until then.
  const earnedKeys = new Set(journey.earned.map((badge) => badge.key));
  const shelf = sortEarnedBadges(journey.earned.filter(isShelfBadge));
  const shareable = new Set<string>(journey.shareableTiers);
  const accent = accentOf(currentTier);

  return (
    <Stack gap="xl">
      <Stack gap={4} className={scoreSectionWidth}>
        <Title order={1}>Your Creator Journey</Title>
        <Text c="dimmed">
          Where your Creator Score stands, what it unlocks next, and the badges you have earned.
          Only you can see this page.
        </Text>
        <Anchor component={NextLink} href={CREATOR_SHOWCASE_HREF} size="sm">
          See the Creator Showcase <IconArrowRight size={14} className="inline" />
        </Anchor>
      </Stack>

      <Card
        withBorder
        radius="lg"
        p={0}
        className={clsx('relative overflow-hidden', scoreSectionWidth)}
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
            <HeroBadge
              tier={currentTier ?? nextTier}
              earned={!!currentTier && earnedKeys.has(currentTier.key)}
            />
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

          {journey.tiers.length > 0 && (
            <BadgeStrip tiers={journey.tiers} earnedKeys={earnedKeys} nextKey={nextTier?.key} />
          )}
        </div>
      </Card>

      <Stack gap="sm" className={scoreSectionWidth}>
        <Title order={2} size="h3">
          The Ladder
        </Title>
        <Stack gap={0}>
          {rungs.map((rung, index) => (
            <LadderRung
              key={rung.tier?.key ?? rung.minScore}
              rung={rung}
              unlockLinks={ladderLinks[index]}
              kinds={kinds}
              isNext={rung === next}
              badgeEarned={!!rung.tier && earnedKeys.has(rung.tier.key)}
              isLast={index === rungs.length - 1}
              username={username}
            />
          ))}
        </Stack>
      </Stack>

      <Stack gap="sm" className={scoreSectionWidth}>
        <Title order={2} size="h3">
          Where Your Score Comes From
        </Title>
        <UserScoreDisplay scores={journey.scores?.breakdown} abbreviate={false} showReports owner />
        <ScoreExplainerToggle />
      </Stack>

      <CreatorAchievements activity={journey.activity} username={username} />

      <CreatorSecrets secrets={journey.secrets} />

      <Stack gap="sm">
        <Title order={2} size="h3">
          Badges Earned
        </Title>
        {shelf.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {shelf.map((badge) => {
              const slug = scoreTierSlugFromKey(badge.key);
              return (
                <EarnedBadgeCard
                  key={badge.key}
                  badge={badge}
                  action={
                    username &&
                    slug &&
                    shareable.has(slug) && (
                      <TierShareButton username={username} slug={slug} tierName={badge.name} />
                    )
                  }
                />
              );
            })}
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

// Artless activity milestones get their own section; the shelf holds tiers and anything with art.
export function isShelfBadge(badge: Pick<Journey['earned'][number], 'track' | 'badgeUrl'>) {
  return badge.track === 'score' || !!badge.badgeUrl;
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

function BadgeStrip({
  tiers,
  earnedKeys,
  nextKey,
}: {
  tiers: CreatorScoreTier[];
  earnedKeys: Set<string>;
  nextKey?: string;
}) {
  const earnedCount = tiers.filter((tier) => earnedKeys.has(tier.key)).length;

  return (
    <div className="flex flex-col gap-2">
      <Text size="xs" tt="uppercase" c="dimmed" fw={600} className="tracking-wider">
        {earnedCount} of {tiers.length} tier badges
      </Text>
      <div className="grid grid-cols-9 gap-1">
        {tiers.map((tier) => {
          const state: BadgeState = earnedKeys.has(tier.key)
            ? 'earned'
            : tier.key === nextKey
            ? 'next'
            : 'locked';
          return (
            <Tooltip
              key={tier.key}
              label={`${tier.name} · ${numberWithCommas(tier.threshold)}`}
              withArrow
              withinPortal
            >
              <div
                className={clsx(
                  'flex w-full min-w-0 max-w-[64px] justify-center justify-self-center rounded-md p-0.5 sm:p-1',
                  state === 'next' && 'bg-white/70 ring-2 ring-[var(--cj-accent)] dark:bg-dark-6'
                )}
                style={accentVar(accentOf(tier))}
              >
                <TierBadge
                  name={tier.name}
                  badgeUrl={tier.badgeUrl}
                  state={state}
                  size={56}
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
          <TierBadge name={next.tier.name} badgeUrl={next.tier.badgeUrl} state="next" size={72} />
        </div>
      )}
    </div>
  );
}

function ScoreExplainerToggle() {
  const [opened, { toggle }] = useDisclosure(false);
  return (
    <div>
      <Anchor component="button" type="button" size="sm" aria-expanded={opened} onClick={toggle}>
        How Creator Score is earned{' '}
        <IconChevronDown
          size={14}
          className={clsx('inline transition-transform', opened && 'rotate-180')}
        />
      </Anchor>
      <Collapse in={opened}>
        <Card withBorder radius="md" mt="xs">
          <CreatorScoreExplainer />
        </Card>
      </Collapse>
    </div>
  );
}

const rungRewards = (rung: CreatorScoreRung) => (rung.tier && tierRewards[rung.tier.key]) ?? [];

/** Each rung's unlock-row links, with repeats collapsed across rung boundaries. */
function ladderUnlockLinks(rungs: CreatorScoreRung[]): PhraseLink[][][] {
  const groups = rungs.map((rung) => groupCreatorScoreUnlocks(rung.unlocks));
  const flat = unlockLinksDownLadder(
    rungs.flatMap((rung, index) => [
      ...rungRewards(rung).map(() => null),
      ...groups[index].map((group) => group.key),
    ])
  );
  let at = 0;
  return rungs.map((rung, index) => {
    at += rungRewards(rung).length;
    const links = flat.slice(at, at + groups[index].length);
    at += groups[index].length;
    return links;
  });
}

function LadderRung({
  rung,
  kinds,
  isNext,
  isLast,
  badgeEarned,
  username,
  unlockLinks,
}: {
  rung: CreatorScoreRung;
  kinds: CreatorScoreKinds;
  isNext: boolean;
  isLast: boolean;
  badgeEarned: boolean;
  username?: string;
  /** Per unlock group, from `ladderUnlockLinks`. */
  unlockLinks: PhraseLink[][];
}) {
  const reached = kinds.total >= rung.minScore;
  const accent = accentOf(rung.tier);
  const state: BadgeState = badgeEarned ? 'earned' : isNext ? 'next' : 'locked';
  const rewards = rungRewards(rung);
  const unlockGroups = groupCreatorScoreUnlocks(rung.unlocks);

  return (
    <div className="flex gap-3 sm:gap-4" style={accentVar(accent)}>
      <div className="flex w-16 shrink-0 flex-col items-center">
        {rung.tier ? (
          <TierBadge name={rung.tier.name} badgeUrl={rung.tier.badgeUrl} state={state} size={64} />
        ) : (
          <div className="flex h-16 items-center">
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
        {rewards.length > 0 || rung.unlocks.length > 0 ? (
          <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {rewards.map((reward) => (
              <UnlockItem key={reward} unlocked={badgeEarned}>
                <LinkedText text={reward} links={rewardLinks(username)} />
              </UnlockItem>
            ))}
            {unlockGroups.map((group, index) => {
              const unlocked = group.unlocks.every((u) => isCreatorScoreUnlockReached(u, kinds));
              return (
                <UnlockItem key={group.key} unlocked={unlocked}>
                  <LinkedText text={group.label} links={unlockLinks[index] ?? []} />
                  {group.minScore !== rung.minScore &&
                    ` (from ${numberWithCommas(group.minScore)})`}
                </UnlockItem>
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

function UnlockItem({ unlocked, children }: { unlocked: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      {unlocked ? (
        <IconCircleCheck size={16} className="mt-0.5 shrink-0 text-green-6" />
      ) : (
        <IconLock size={16} className="mt-0.5 shrink-0 text-gray-5" />
      )}
      <Text size="sm" c={unlocked ? undefined : 'dimmed'}>
        {children}
      </Text>
    </li>
  );
}
