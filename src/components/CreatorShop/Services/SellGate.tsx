import { Group, Paper, Progress, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import type { useQueryMyServices } from '~/components/CreatorShop/Services/creator-service.util';

export type SellEligibility = NonNullable<ReturnType<typeof useQueryMyServices>['eligibility']>;

export function SellGate({ eligibility }: { eligibility: SellEligibility }) {
  const { current, min } = eligibility.score;
  return (
    <Paper withBorder radius="md" p="md">
      <Group wrap="nowrap" align="flex-start">
        <ThemeIcon size={44} radius="md" variant="light" color="gray">
          <IconLock size={22} />
        </ThemeIcon>
        <Stack gap={6} className="flex-1">
          <Text fw={600}>Services unlock at Beacon ({min.toLocaleString()} Creator Score)</Text>
          {eligibility.standingIssue ? (
            <Text size="sm" c="dimmed">
              {eligibility.standingIssue}
            </Text>
          ) : (
            <>
              <Text size="sm" c="dimmed">
                Same point you can join the Creator Program. You&apos;re at{' '}
                {Math.floor(current).toLocaleString()}.
              </Text>
              <Progress value={Math.min(100, (current / min) * 100)} color="yellow" size="sm" />
            </>
          )}
        </Stack>
      </Group>
    </Paper>
  );
}
