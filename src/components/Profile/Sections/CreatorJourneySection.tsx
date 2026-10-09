import { Button, Text } from '@mantine/core';
import clsx from 'clsx';
import { IconArrowRight, IconTrophy } from '@tabler/icons-react';
import { AchievementGrid, ProfileTierCard } from '~/components/CreatorJourney/ProfileAchievements';
import { useProfileAchievements } from '~/components/CreatorJourney/useProfileAchievements';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { ProfileSection } from '~/components/Profile/ProfileSection';
import classes from '~/components/Profile/ProfileSection.module.css';

const LATEST_ACHIEVEMENTS = 6;

export const CreatorJourneySection = ({ user }: ProfileSectionProps) => {
  const { data, count } = useProfileAchievements(user.id);
  if (!data || count === 0) return null;

  const tier = data.tiers.at(-1);
  const latest = data.achievements.slice(0, LATEST_ACHIEVEMENTS);

  return (
    <div className={classes.profileSection}>
      <ProfileSection
        title="Creator Journey"
        icon={<IconTrophy />}
        action={
          <Button
            component={Link}
            href={`/user/${user.username}/achievements`}
            h={34}
            variant="subtle"
            rightSection={<IconArrowRight size={16} />}
          >
            <Text inherit>View all achievements</Text>
          </Button>
        }
      >
        <div
          className={clsx(
            'grid grid-cols-1 gap-4',
            tier && 'md:grid-cols-[minmax(220px,280px)_1fr]'
          )}
        >
          {tier && <ProfileTierCard tier={tier} userId={user.id} />}
          {latest.length > 0 && (
            <div className="flex min-w-0 flex-col gap-2">
              <Text size="sm" fw={600} c="dimmed">
                Latest achievements
              </Text>
              <AchievementGrid achievements={latest} cols={{ base: 2, sm: 3 }} />
            </div>
          )}
        </div>
      </ProfileSection>
    </div>
  );
};
