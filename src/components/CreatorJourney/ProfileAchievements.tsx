import { Anchor, Stack, Text, Title } from '@mantine/core';
import { achievementTracks, earnedLabel } from '~/components/CreatorJourney/CreatorAchievements';
import { SECRET_ACCENT } from '~/components/CreatorJourney/CreatorSecrets';
import { EarnedBadgeCard } from '~/components/CreatorJourney/EarnedBadgeCard';
import { TierShareButton } from '~/components/CreatorJourney/TierShareButton';
import {
  accentVar,
  DEFAULT_ACCENT,
  tierAccents,
  TierBadge,
} from '~/components/CreatorJourney/tier-badge';
import { NextLink } from '~/components/NextLink/NextLink';
import { SpotlightBorderCard } from '~/components/SpotlightCard/SpotlightBorderCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  CREATOR_JOURNEY_HREF,
  scoreTierSlugFromKey,
} from '~/shared/constants/creator-journey.constants';
import { creatorScoreFromSession } from '~/shared/utils/creator-score';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import type { RouterOutput } from '~/types/router';

type ProfileAchievements = RouterOutput['creatorJourney']['getProfileAchievements'];
type Tier = ProfileAchievements['tiers'][number];
type Achievement = ProfileAchievements['achievements'][number];

export const SECRET_ACHIEVEMENT_LABEL = 'Secret achievement';

/** The width of an earned-badge card on the journey page's shelf, so the profile's cards match it. */
export const BADGE_CARD_GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,220px)]';

const achievementName = (achievement: Achievement) => achievement.name ?? SECRET_ACHIEVEMENT_LABEL;

function accentOfTrack(track: string) {
  if (track === 'secret') return SECRET_ACCENT;
  return achievementTracks.find((t) => t.key === track)?.accent ?? DEFAULT_ACCENT;
}

export function AchievementCard({ achievement }: { achievement: Achievement }) {
  return (
    <EarnedBadgeCard
      badge={{ ...achievement, name: achievementName(achievement) }}
      accent={accentOfTrack(achievement.track)}
    />
  );
}

/** The highest tier held, never the score: only the owner, who already has it, sees the number. */
export function ProfileTierCard({ tier, userId }: { tier: Tier; userId: number }) {
  const currentUser = useCurrentUser();
  const isOwner = currentUser?.id === userId;
  const ownScore = isOwner ? creatorScoreFromSession(currentUser) : undefined;
  const accent = tierAccents[tier.key] ?? DEFAULT_ACCENT;
  const slug = scoreTierSlugFromKey(tier.key);
  const { data: shareable } = trpc.creatorJourney.isMilestoneShareable.useQuery(
    { userId, slug: slug ?? 'spark' },
    { enabled: isOwner && !!slug }
  );

  return (
    <SpotlightBorderCard
      color={accent}
      size={320}
      style={accentVar(accent)}
      faceClassName="flex flex-col items-center gap-2 p-5 text-center"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-32 opacity-25"
        style={{
          background: 'radial-gradient(60% 100% at 50% 0%, var(--cj-accent) 0%, transparent 100%)',
        }}
      />
      {isOwner && shareable && slug && currentUser?.username && (
        <div className="absolute right-2 top-2">
          <TierShareButton username={currentUser.username} slug={slug} tierName={tier.name} />
        </div>
      )}
      <Text size="xs" tt="uppercase" fw={700} c="dimmed" className="tracking-wider">
        Creator Score tier
      </Text>
      <TierBadge name={tier.name} badgeUrl={tier.badgeUrl} state="earned" size={104} />
      <Text fw={800} size="xl">
        {tier.name}
      </Text>
      {tier.achievedAt && (
        <Text size="sm" c="dimmed">
          {earnedLabel(tier.achievedAt)}
        </Text>
      )}
      {ownScore !== undefined && (
        <Text
          size="sm"
          className="w-full rounded-md border border-dashed border-gray-3 p-2 dark:border-dark-4"
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
    </SpotlightBorderCard>
  );
}

const achievementGroups = [
  ...achievementTracks.map(({ key, title }) => ({ key, title })),
  { key: 'secret', title: 'Secret' },
];

/**
 * A held tier as an earned card. The threshold comes from the public ladder, not the profile payload,
 * which carries no numbers; a tier the ladder masks shows none.
 */
function TierCard({ tier, threshold }: { tier: Tier; threshold?: number }) {
  return (
    <EarnedBadgeCard
      badge={{ ...tier, track: 'score', threshold, description: null }}
      accent={tierAccents[tier.key] ?? DEFAULT_ACCENT}
    />
  );
}

/** The Achievements tab: the highest tier, every earned tier, then each achievement by track. */
export function ProfileAchievementsList({
  data,
  userId,
}: {
  data: ProfileAchievements;
  userId: number;
}) {
  const { data: ladder } = trpc.creatorJourney.getLadder.useQuery();
  const thresholds = new Map(ladder?.tiers.map((tier) => [tier.key, tier.threshold]));
  const highest = data.tiers.at(-1);

  const known = new Set(achievementGroups.map((group) => group.key));
  const groups = [
    ...achievementGroups.map((group) => ({
      ...group,
      items: data.achievements.filter((a) => a.track === group.key),
    })),
    { key: 'other', title: 'More', items: data.achievements.filter((a) => !known.has(a.track)) },
  ].filter((group) => group.items.length > 0);

  return (
    <Stack gap="xl">
      {highest && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(220px,280px)_1fr]">
          <div className="md:self-start">
            <ProfileTierCard tier={highest} userId={userId} />
          </div>
          <Stack gap="sm" className="min-w-0">
            <GroupTitle title="Creator Score" count={data.tiers.length} />
            <div className={BADGE_CARD_GRID}>
              {[...data.tiers].reverse().map((tier) => (
                <TierCard key={tier.key} tier={tier} threshold={thresholds.get(tier.key)} />
              ))}
            </div>
          </Stack>
        </div>
      )}
      {groups.map((group) => (
        <Stack key={group.key} gap="sm">
          <GroupTitle title={group.title} count={group.items.length} />
          <AchievementGrid achievements={group.items} />
        </Stack>
      ))}
    </Stack>
  );
}

export function AchievementGrid({
  achievements,
  className = BADGE_CARD_GRID,
}: {
  achievements: Achievement[];
  className?: string;
}) {
  return (
    <div className={className}>
      {achievements.map((achievement) => (
        <AchievementCard key={achievement.key} achievement={achievement} />
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
