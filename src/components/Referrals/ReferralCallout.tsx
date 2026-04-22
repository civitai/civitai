import { Button, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconGift } from '@tabler/icons-react';
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
        className={clsx('bg-gradient-to-r from-pink-9/20 via-grape-9/15 to-indigo-9/20', className)}
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
          <Button
            component={Link}
            href="/user/referrals"
            size="compact-xs"
            variant="light"
            color="pink"
          >
            Refer a friend
          </Button>
        </Group>
      </Paper>
    );
  }

  return (
    <Paper
      p="lg"
      radius="md"
      className={className}
      style={{
        background: 'light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-5))',
        border: '1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))',
      }}
    >
      <Group justify="space-between" wrap="nowrap" align="center" gap="md">
        <Stack gap={4} className="min-w-0 flex-1">
          <Group gap="xs">
            <ThemeIcon variant="light" color="violet" size="lg" radius="md">
              <IconGift size={18} />
            </ThemeIcon>
            <Text fw={700} size="lg">
              Earn free Membership perks
            </Text>
          </Group>
          <Text size="sm" c="dimmed">
            Share your code. Every paid Membership month from a friend earns you Tokens you can
            spend on Membership perks, plus 10% Blue Buzz back on their Buzz purchases.
          </Text>
        </Stack>
        <Button
          component={Link}
          href="/user/referrals"
          variant="gradient"
          gradient={{ from: 'blue', to: 'violet', deg: 45 }}
          leftSection={<IconGift size={16} />}
        >
          Open Referrals
        </Button>
      </Group>
    </Paper>
  );
}
