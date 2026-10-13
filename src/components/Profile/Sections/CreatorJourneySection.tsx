import { Button, Text } from '@mantine/core';
import { IconArrowRight, IconTrophy } from '@tabler/icons-react';
import { sortEarnedBadges } from '~/components/CreatorJourney/badge-order';
import { AchievementGrid, TierLadderBand } from '~/components/CreatorJourney/ProfileAchievements';
import { useProfileAchievements } from '~/components/CreatorJourney/useProfileAchievements';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { ProfileSection } from '~/components/Profile/ProfileSection';
import classes from '~/components/Profile/ProfileSection.module.css';

// One desktop row.
const LATEST_ACHIEVEMENTS = 5;

export const CreatorJourneySection = ({ user }: ProfileSectionProps) => {
  const { data, count } = useProfileAchievements(user.id);
  if (!data || count === 0) return null;

  const latest = sortEarnedBadges(data.achievements).slice(0, LATEST_ACHIEVEMENTS);

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
        <div className="flex flex-col gap-4">
          {data.tiers.length > 0 && <TierLadderBand tiers={data.tiers} userId={user.id} />}
          {latest.length > 0 && (
            <div className="flex min-w-0 flex-col gap-2 @container">
              <Text size="sm" fw={600} c="dimmed">
                Latest achievements
              </Text>
              <AchievementGrid
                achievements={latest}
                className="grid grid-cols-2 gap-3 @[480px]:grid-cols-3 @[760px]:grid-cols-5"
              />
            </div>
          )}
        </div>
      </ProfileSection>
    </div>
  );
};
