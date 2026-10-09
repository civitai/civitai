import { Anchor, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { achievementTracks, earnedLabel } from '~/components/CreatorJourney/CreatorAchievements';
import { SECRET_ACCENT } from '~/components/CreatorJourney/CreatorSecrets';
import {
  accentVar,
  DEFAULT_ACCENT,
  tierAccents,
  TierBadge,
} from '~/components/CreatorJourney/tier-badge';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';
import { creatorScoreFromSession } from '~/shared/utils/creator-score';
import { numberWithCommas } from '~/utils/number-helpers';
import type { RouterOutput } from '~/types/router';

type ProfileAchievements = RouterOutput['creatorJourney']['getProfileAchievements'];
type Tier = ProfileAchievements['tiers'][number];
type Achievement = ProfileAchievements['achievements'][number];

export const SECRET_ACHIEVEMENT_LABEL = 'Secret achievement';

const achievementName = (achievement: Achievement) => achievement.name ?? SECRET_ACHIEVEMENT_LABEL;

function accentOfTrack(track: string) {
  if (track === 'secret') return SECRET_ACCENT;
  return achievementTracks.find((t) => t.key === track)?.accent ?? DEFAULT_ACCENT;
}

export function AchievementTile({ achievement }: { achievement: Achievement }) {
  const name = achievementName(achievement);
  return (
    <div
      className="flex min-w-0 flex-col items-center gap-2 rounded-md bg-gray-0 p-3 text-center dark:bg-dark-6"
      style={accentVar(accentOfTrack(achievement.track))}
      title={achievement.description ?? undefined}
    >
      <TierBadge name={name} badgeUrl={achievement.badgeUrl} state="earned" size={64} />
      <Text
        size="sm"
        fw={700}
        lh={1.25}
        fs={achievement.name ? undefined : 'italic'}
        c={achievement.name ? undefined : 'dimmed'}
      >
        {name}
      </Text>
      <Text size="xs" c="dimmed">
        {earnedLabel(achievement.achievedAt)}
      </Text>
    </div>
  );
}

/** The highest tier held, never the score: only the owner, who already has it, sees the number. */
export function ProfileTierCard({ tier, userId }: { tier: Tier; userId: number }) {
  const currentUser = useCurrentUser();
  const ownScore = currentUser?.id === userId ? creatorScoreFromSession(currentUser) : undefined;
  const accent = tierAccents[tier.key] ?? DEFAULT_ACCENT;

  return (
    <div
      className="flex flex-col items-center gap-2 rounded-lg border border-solid border-[color-mix(in_srgb,var(--cj-accent)_45%,transparent)] bg-gray-0 p-5 text-center dark:bg-dark-6"
      style={{
        ...accentVar(accent),
        backgroundImage:
          'radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--cj-accent) 25%, transparent), transparent 70%)',
      }}
    >
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
    </div>
  );
}

const achievementGroups = [
  ...achievementTracks.map(({ key, title }) => ({ key, title })),
  { key: 'secret', title: 'Secret' },
];

/** The Achievements tab: every earned tier and achievement, grouped by track. */
export function ProfileAchievementsList({ data }: { data: ProfileAchievements }) {
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
      {data.tiers.length > 0 && (
        <Stack gap="sm">
          <GroupTitle title="Creator Score" count={data.tiers.length} />
          <div className="flex flex-wrap items-end gap-4">
            {data.tiers.map((tier, index) => {
              const highest = index === data.tiers.length - 1;
              return (
                <div
                  key={tier.key}
                  className="flex w-20 flex-col items-center gap-1.5 text-center"
                  style={accentVar(tierAccents[tier.key] ?? DEFAULT_ACCENT)}
                >
                  <TierBadge
                    name={tier.name}
                    badgeUrl={tier.badgeUrl}
                    state="earned"
                    size={highest ? 72 : 56}
                  />
                  <Text size="sm" fw={highest ? 800 : 600}>
                    {tier.name}
                  </Text>
                </div>
              );
            })}
          </div>
        </Stack>
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
  className,
}: {
  achievements: Achievement[];
  className?: string;
}) {
  return (
    <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 6 }} spacing="sm" className={className}>
      {achievements.map((achievement) => (
        <AchievementTile key={achievement.key} achievement={achievement} />
      ))}
    </SimpleGrid>
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
