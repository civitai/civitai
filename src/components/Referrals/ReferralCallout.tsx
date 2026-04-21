import { Button, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconGift, IconSparkles } from '@tabler/icons-react';
import clsx from 'clsx';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

type ReferralCalloutProps = {
  variant?: 'full' | 'compact';
  className?: string;
};

/**
 * Dashboard callout driving users to the referral program. Gated on the
 * referralProgramV2 feature flag; renders nothing when the program is off.
 */
export function ReferralCallout({ variant = 'full', className }: ReferralCalloutProps) {
  const features = useFeatureFlags();
  if (!features.referralProgramV2) return null;

  if (variant === 'compact') {
    return (
      <Paper
        withBorder
        p="sm"
        radius="md"
        className={clsx(
          'bg-gradient-to-r from-pink-9/20 via-grape-9/15 to-indigo-9/20',
          className
        )}
      >
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Group gap="xs" wrap="nowrap">
            <ThemeIcon variant="light" color="pink" size="md" radius="md">
              <IconGift size={16} />
            </ThemeIcon>
            <Text size="sm" fw={600} className="leading-tight">
              Share Civitai, earn Membership perks
            </Text>
          </Group>
          <Button component={Link} href="/user/referrals" size="compact-xs" variant="light" color="pink">
            Refer a friend
          </Button>
        </Group>
      </Paper>
    );
  }

  return (
    <Paper
      withBorder
      p="lg"
      radius="md"
      className={clsx(
        'relative overflow-hidden bg-gradient-to-br from-pink-9/30 via-grape-9/20 to-indigo-9/25',
        className
      )}
    >
      <Group justify="space-between" wrap="nowrap" align="center" gap="md">
        <Stack gap={4} className="min-w-0 flex-1">
          <Group gap="xs">
            <ThemeIcon variant="light" color="pink" size="lg" radius="md">
              <IconSparkles size={18} />
            </ThemeIcon>
            <Text fw={700} size="lg">
              Earn free Membership perks
            </Text>
          </Group>
          <Text size="sm" c="dimmed">
            Share your code. When friends subscribe, you earn tokens for Bronze / Silver / Gold
            perks. They get a Blue Buzz bonus. Every referee purchase earns you 10% Blue Buzz.
          </Text>
        </Stack>
        <Button
          component={Link}
          href="/user/referrals"
          variant="gradient"
          gradient={{ from: 'pink', to: 'grape' }}
          leftSection={<IconGift size={16} />}
        >
          Open Referrals
        </Button>
      </Group>
    </Paper>
  );
}
