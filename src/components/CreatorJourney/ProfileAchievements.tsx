import { Anchor, Stack, Text, Title, Tooltip } from '@mantine/core';
import clsx from 'clsx';
import { sortEarnedBadges } from '~/components/CreatorJourney/badge-order';
import { achievementTracks, earnedLabel } from '~/components/CreatorJourney/CreatorAchievements';
import { SECRET_ACCENT } from '~/components/CreatorJourney/CreatorSecrets';
import { EarnedBadgeCard } from '~/components/CreatorJourney/EarnedBadgeCard';
import { MilestoneShareButton } from '~/components/CreatorJourney/MilestoneShareButton';
import { ScoreSplitBar } from '~/components/CreatorJourney/ScoreSplitBar';
import {
  accentVar,
  DEFAULT_ACCENT,
  tierAccents,
  TierBadge,
} from '~/components/CreatorJourney/tier-badge';
import { NextLink } from '~/components/NextLink/NextLink';
import { SpotlightBorderCard } from '~/components/SpotlightCard/SpotlightBorderCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import type { ScoreTierSlug } from '~/shared/constants/creator-journey.constants';
import {
  CREATOR_JOURNEY_HREF,
  isMaskedMilestoneKey,
  milestoneKeyOfShareToken,
  parseScoreTierSlug,
  SCORE_TIERS,
  scoreTierKey,
} from '~/shared/constants/creator-journey.constants';
import { creatorScoreFromSession } from '~/shared/utils/creator-score';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import type { RouterOutput } from '~/types/router';

type ProfileAchievements = RouterOutput['creatorJourney']['getProfileAchievements'];
type Tier = ProfileAchievements['tiers'][number];
type Achievement = ProfileAchievements['achievements'][number];
type LadderTier = RouterOutput['creatorJourney']['getLadder']['tiers'][number];
type Rung = {
  key: string;
  name: string;
  badgeUrl: string | null;
  threshold?: number;
  held?: Tier;
  /**
   * Below a held tier but not shown, e.g. its badge hidden from the profile: the score passed it.
   * Drawn with the public ladder's art, never the creator's earned date.
   */
  reached?: boolean;
};

export const SECRET_ACHIEVEMENT_LABEL = 'Special achievement';

/** Cards about as wide as the journey page's shelf (four across its 960px container), wrapping. */
export const BADGE_CARD_GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,220px)]';

const achievementName = (achievement: Achievement) => achievement.name ?? SECRET_ACHIEVEMENT_LABEL;

function accentOfTrack(track: string) {
  if (track === 'secret') return SECRET_ACCENT;
  return achievementTracks.find((t) => t.key === track)?.accent ?? DEFAULT_ACCENT;
}

export function AchievementCard({
  achievement,
  action,
}: {
  achievement: Achievement;
  action?: ReactNode;
}) {
  return (
    <EarnedBadgeCard
      badge={{ ...achievement, name: achievementName(achievement) }}
      accent={accentOfTrack(achievement.track)}
      action={action}
    />
  );
}

/** The owner's share states; empty for anyone else, who is never asked about them. */
function useMyShareStates(isOwner: boolean) {
  const { data } = trpc.creatorJourney.getMyShareStates.useQuery(undefined, { enabled: isOwner });
  return {
    shareable: new Set(isOwner ? data?.shareable : undefined),
    secret: new Set(isOwner ? data?.secret : undefined),
  };
}

/**
 * Every tier on the public ladder, lowest first, carrying the creator's earned tier where they hold
 * it. A tier the ladder masks shows no threshold, and never reads as reached. Until the ladder loads,
 * the held tiers alone.
 */
export function ladderRungs(held: Tier[], ladder: LadderTier[] | undefined): Rung[] {
  if (!ladder) return held.map((tier) => ({ ...tier, held: tier }));
  const unplaced = new Map(held.map((tier) => [tier.key, tier]));
  const rungs = ladder.map((tier, index): Rung => {
    const masked = isMaskedMilestoneKey(tier.key);
    // The ladder masks a hidden tier for everyone, its owner included; the owner's own copy is real.
    const slug = masked ? SCORE_TIERS[index]?.slug : undefined;
    const own = unplaced.get(slug ? scoreTierKey(slug) : tier.key);
    if (own) unplaced.delete(own.key);
    return {
      key: own?.key ?? tier.key,
      name: own?.name ?? tier.name,
      badgeUrl: own ? own.badgeUrl : tier.badgeUrl ?? null,
      threshold: masked ? undefined : tier.threshold,
      held: own,
    };
  });
  const top = rungs.findLastIndex((rung) => rung.held);
  rungs.forEach((rung, index) => {
    if (index < top && !rung.held && rung.threshold != null) rung.reached = true;
  });
  return [...rungs, ...[...unplaced.values()].map((tier) => ({ ...tier, held: tier }))];
}

/** The element id of a tier's rung on the Achievements tab, for a shared tier link to land on. */
export const tierCardId = (slug: ScoreTierSlug) => `tier-${slug}`;

/** The element id of the card a share token names: a tier's, or an achievement's by its key. */
export function milestoneCardId(token: string) {
  const slug = parseScoreTierSlug(token);
  return slug ? tierCardId(slug) : `achievement-${token}`;
}

/** The strip's `scrollLeft` that centres a rung. The strip is positioned, so it is the offset parent. */
export const centredScrollLeft = (rung: HTMLElement, strip: HTMLElement) =>
  rung.offsetLeft - (strip.clientWidth - rung.offsetWidth) / 2;

function TierRungChip({
  rung,
  current,
  spotlightId,
}: {
  rung: Rung;
  current: boolean;
  spotlightId?: string;
}) {
  const lit = !!rung.held || !!rung.reached;
  const status = rung.held
    ? earnedLabel(rung.held.achievedAt)
    : rung.reached
    ? 'Reached'
    : rung.threshold != null
    ? `Unlocks at ${numberWithCommas(rung.threshold)} Creator Score`
    : 'Locked';
  return (
    <Tooltip label={status} events={{ hover: true, focus: true, touch: true }}>
      <button
        type="button"
        id={spotlightId}
        data-spotlight={spotlightId ? true : undefined}
        aria-label={`${rung.name}: ${status}`}
        aria-current={current || undefined}
        className={clsx(
          'flex w-[72px] shrink-0 flex-col items-center gap-1 rounded-md px-0.5 py-1.5',
          // Inset: the strip clips anything drawn outside a rung.
          spotlightId && 'scroll-mt-24 ring-2 ring-inset ring-yellow-5'
        )}
        style={{
          ...accentVar(tierAccents[rung.key] ?? DEFAULT_ACCENT),
          background: current ? 'color-mix(in srgb, var(--cj-accent) 16%, transparent)' : undefined,
        }}
      >
        <TierBadge
          name={rung.name}
          badgeUrl={rung.badgeUrl}
          state={lit ? 'earned' : 'locked'}
          size={48}
        />
        <Text size="xs" fw={700} lh={1.1} c={lit ? undefined : 'dimmed'}>
          {rung.name}
        </Text>
        {rung.threshold != null && (
          <Text fz={10} c="dimmed" className="tabular-nums">
            {numberWithCommas(rung.threshold)}+
          </Text>
        )}
      </button>
    </Tooltip>
  );
}

/**
 * The highest tier held beside the whole ladder. Never the score: only the owner, who already has it,
 * sees the number. `spotlight` is a shared link's token; the tier it names has its rung ringed.
 */
export function TierLadderBand({
  tiers,
  userId,
  spotlight,
}: {
  tiers: Tier[];
  userId: number;
  spotlight?: string | null;
}) {
  const currentUser = useCurrentUser();
  const isOwner = currentUser?.id === userId;
  const ownScore = isOwner ? creatorScoreFromSession(currentUser) : undefined;
  const share = useMyShareStates(isOwner);
  const { data: ladder } = trpc.creatorJourney.getLadder.useQuery();
  const spotlightKey = spotlight ? milestoneKeyOfShareToken(spotlight) : undefined;
  const spotlightId =
    spotlight && tiers.some((tier) => tier.key === spotlightKey)
      ? milestoneCardId(spotlight)
      : undefined;
  // On a phone the strip scrolls sideways, so a shared rung is centred in it. Only once the ladder is
  // in: until then the strip holds the held tiers alone, and the rung moves when the rest arrive.
  useEffect(() => {
    if (!ladder || !spotlightId) return;
    const frame = requestAnimationFrame(() => {
      const rung = document.getElementById(spotlightId);
      const strip = rung?.closest<HTMLElement>('[data-tier-ladder]');
      if (rung && strip) strip.scrollTo({ left: centredScrollLeft(rung, strip) });
    });
    return () => cancelAnimationFrame(frame);
  }, [ladder, spotlightId]);
  const highest = tiers.at(-1);
  if (!highest) return null;
  const accent = tierAccents[highest.key] ?? DEFAULT_ACCENT;

  return (
    <Stack gap="xs">
      <SpotlightBorderCard
        color={accent}
        size={320}
        style={accentVar(accent)}
        faceClassName="flex flex-col gap-3 p-4 md:flex-row md:items-center md:gap-5 md:p-5"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-1/2 opacity-25"
          style={{
            background: 'radial-gradient(80% 90% at 0% 50%, var(--cj-accent) 0%, transparent 100%)',
          }}
        />
        {share.shareable.has(highest.key) && currentUser?.username && (
          <div className="absolute right-2 top-2 z-10">
            <MilestoneShareButton
              username={currentUser.username}
              milestoneKey={highest.key}
              name={highest.name}
              secret={share.secret.has(highest.key)}
            />
          </div>
        )}
        <div className="relative flex shrink-0 items-center gap-4 pr-8 md:pr-0">
          <TierBadge name={highest.name} badgeUrl={highest.badgeUrl} state="earned" size={88} />
          <div className="flex flex-col">
            <Text size="xs" tt="uppercase" fw={700} c="dimmed" className="tracking-wider">
              Creator Score tier
            </Text>
            <Text fw={800} fz={24} lh={1.15}>
              {highest.name}
            </Text>
            <Text size="sm" c="dimmed">
              {earnedLabel(highest.achievedAt)}
            </Text>
          </div>
        </div>
        <div
          data-tier-ladder
          className="relative flex min-w-0 flex-1 gap-0.5 overflow-x-auto md:justify-between md:pr-8"
        >
          {ladderRungs(tiers, ladder?.tiers).map((rung) => (
            <TierRungChip
              key={rung.key}
              rung={rung}
              current={rung.key === highest.key}
              spotlightId={rung.held && rung.key === spotlightKey ? spotlightId : undefined}
            />
          ))}
        </div>
      </SpotlightBorderCard>
      {ownScore !== undefined && (
        <Text
          size="sm"
          ta="center"
          className="rounded-md border border-dashed border-gray-3 p-2 dark:border-dark-4"
        >
          Only you see this: score{' '}
          <Text span fw={700} className="tabular-nums">
            {numberWithCommas(Math.floor(ownScore))}
          </Text>
          .{' '}
          <Anchor component={NextLink} href={CREATOR_JOURNEY_HREF} inherit>
            Open your journey
          </Anchor>
        </Text>
      )}
    </Stack>
  );
}

/** Where the band would be, for an owner with no tier yet. */
function NoTierYet() {
  const { data: ladder } = trpc.creatorJourney.getLadder.useQuery();
  const first = ladder?.tiers[0];
  const firstShown = first && !isMaskedMilestoneKey(first.key) ? first : undefined;
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed border-gray-3 p-3 dark:border-dark-4">
      <TierBadge name="?" state="locked" size={40} />
      <Text size="sm">
        <Text span fw={700}>
          No Creator Score tier yet.
        </Text>{' '}
        {firstShown && (
          <>
            {firstShown.name} unlocks at {numberWithCommas(firstShown.threshold)}.{' '}
          </>
        )}
        <Anchor component={NextLink} href={CREATOR_JOURNEY_HREF} inherit>
          Open your journey
        </Anchor>
      </Text>
    </div>
  );
}

const achievementGroups = [
  ...achievementTracks.map(({ key, title }) => ({ key, title })),
  { key: 'secret', title: 'Special' },
];

/** A card a shared link named, ringed; any other card as it is. */
function Spotlit({
  milestoneKey,
  spotlit,
  spotlight,
  children,
}: {
  milestoneKey: string;
  /** A secret the server matched to the link, whose key a visitor is never sent. */
  spotlit?: boolean;
  spotlight?: string | null;
  children: ReactNode;
}) {
  if (!spotlight || (!spotlit && milestoneKeyOfShareToken(spotlight) !== milestoneKey))
    return <>{children}</>;
  return (
    <div
      id={milestoneCardId(spotlight)}
      data-spotlight
      // A one-cell grid: this is the grid item that stretches to the row, and its card stretches with
      // it. Same radius as the card, so the ring follows its corners.
      className="grid scroll-mt-24 rounded-md ring-2 ring-yellow-5 ring-offset-2 ring-offset-white dark:ring-offset-dark-7"
    >
      {children}
    </div>
  );
}

/**
 * The Achievements tab: the tier ladder, then each achievement by track. `spotlight` is the share
 * token a shared link named: its card or rung is scrolled to and ringed.
 */
export function ProfileAchievementsList({
  data,
  userId,
  spotlight,
}: {
  data: ProfileAchievements;
  userId: number;
  spotlight?: string | null;
}) {
  const currentUser = useCurrentUser();
  const isOwner = currentUser?.id === userId;
  const share = useMyShareStates(isOwner);
  const spotlightKey = spotlight ? milestoneKeyOfShareToken(spotlight) : undefined;
  const spotlit =
    !!spotlightKey &&
    (data.tiers.some((tier) => tier.key === spotlightKey) ||
      data.achievements.some((a) => a.spotlit || a.key === spotlightKey));
  useEffect(() => {
    if (!spotlit || !spotlight) return;
    // A frame later: the app's scroll area resets to the top in its own effect, which runs after
    // this one when the list mounts with the page (data already cached by the profile).
    const frame = requestAnimationFrame(() =>
      document
        .getElementById(milestoneCardId(spotlight))
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    );
    return () => cancelAnimationFrame(frame);
  }, [spotlit, spotlight]);
  const achievements = sortEarnedBadges(data.achievements);

  const known = new Set(achievementGroups.map((group) => group.key));
  const groups = [
    ...achievementGroups.map((group) => ({
      ...group,
      items: achievements.filter((a) => a.track === group.key),
    })),
    { key: 'other', title: 'More', items: achievements.filter((a) => !known.has(a.track)) },
  ].filter((group) => group.items.length > 0);

  return (
    <Stack gap="xl">
      {isOwner && (
        <Anchor component={NextLink} href={CREATOR_JOURNEY_HREF} size="sm" className="self-start">
          See your progress on your Creator Journey
        </Anchor>
      )}
      {data.tiers.length > 0 ? (
        <Stack gap="md">
          <TierLadderBand tiers={data.tiers} userId={userId} spotlight={spotlight} />
          {data.scoreSplit && <ScoreSplitBar split={data.scoreSplit} />}
        </Stack>
      ) : (
        isOwner && <NoTierYet />
      )}
      {groups.map((group) => (
        <Stack key={group.key} gap="sm">
          <GroupTitle title={group.title} count={group.items.length} />
          <AchievementGrid
            achievements={group.items}
            spotlight={spotlight}
            action={(achievement) =>
              share.shareable.has(achievement.key) &&
              currentUser?.username && (
                <MilestoneShareButton
                  username={currentUser.username}
                  milestoneKey={achievement.key}
                  name={achievementName(achievement)}
                  secret={share.secret.has(achievement.key)}
                />
              )
            }
          />
        </Stack>
      ))}
    </Stack>
  );
}

export function AchievementGrid({
  achievements,
  className = BADGE_CARD_GRID,
  spotlight,
  action,
}: {
  achievements: Achievement[];
  className?: string;
  spotlight?: string | null;
  action?: (achievement: Achievement) => ReactNode;
}) {
  return (
    <div className={className}>
      {achievements.map((achievement) => (
        <Spotlit
          key={achievement.key}
          milestoneKey={achievement.key}
          spotlit={achievement.spotlit}
          spotlight={spotlight}
        >
          <AchievementCard achievement={achievement} action={action?.(achievement)} />
        </Spotlit>
      ))}
    </div>
  );
}

function GroupTitle({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <Title order={3} size="h4">
        {title}
      </Title>
      <Text size="sm" c="dimmed" className="tabular-nums">
        {count} earned
      </Text>
    </div>
  );
}
