import { Anchor, Card, Group, Stack, Text } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { NextLink } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { getEarlyAccessEntryRung } from '~/server/utils/early-access-helpers';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';
import { numberWithCommas } from '~/utils/number-helpers';

/** Stands where the early-access editor would be for a creator whose score has not opened it yet. */
export function EarlyAccessLockedRow({ score }: { score: number | undefined }) {
  const journey = !!useFeatureFlags().creatorJourney;
  const rung = getEarlyAccessEntryRung();
  if (!rung) return null;
  const threshold = numberWithCommas(rung.minScore);

  return (
    <Card withBorder mt="md" p="sm">
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <IconLock size={18} className="mt-0.5 shrink-0" />
        <Stack gap={2}>
          <Text fw={600} size="sm">
            Early access unlocks at a Creator Score of {threshold}
          </Text>
          <Text size="sm" c="dimmed">
            {score != null && <>You&apos;re at {numberWithCommas(Math.floor(score))}. </>}
            At {threshold} you can hold {rung.versions}{' '}
            {rung.versions === 1 ? 'version' : 'versions'} in early access for up to {rung.days}{' '}
            days. Higher scores raise both.
            {journey && (
              <>
                {' '}
                <Anchor component={NextLink} href={CREATOR_JOURNEY_HREF} inherit>
                  See your journey
                </Anchor>
              </>
            )}
          </Text>
        </Stack>
      </Group>
    </Card>
  );
}
