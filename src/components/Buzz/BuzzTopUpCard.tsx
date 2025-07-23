import { Button, Card, Group, Stack, Text, ThemeIcon, Badge, Center } from '@mantine/core';
import { IconBolt, IconPlus, IconTrendingUp } from '@tabler/icons-react';
import React from 'react';
import { UserBuzz } from '~/components/User/UserBuzz';
import { dialogStore } from '~/components/Dialog/dialogStore';
import classes from './BuzzTopUpCard.module.scss';

interface BuzzTopUpCardProps {
  /**
   * Account ID for the user
   */
  accountId: number;
  /**
   * Size variant for the component
   */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Layout variant
   */
  variant?: 'compact' | 'full' | 'banner';
  /**
   * Custom message to display
   */
  message?: string;
  /**
   * Whether to show current buzz balance
   */
  showBalance?: boolean;
  /**
   * Custom class name for styling
   */
  className?: string;
  /**
   * Whether to show the component as a banner/alert style
   */
  asBanner?: boolean;
  btnLabel?: string;
}

export function BuzzTopUpCard({
  accountId,
  size = 'md',
  variant = 'full',
  message,
  showBalance = true,
  className,
  asBanner = false,
  btnLabel = 'Top Up Now',
}: BuzzTopUpCardProps) {
  const handleTopUp = async () => {
    const BuyBuzzModal = (await import('~/components/Modals/BuyBuzzModal')).default;
    dialogStore.trigger({
      component: BuyBuzzModal,
    });
  };

  // Compact variant for smaller spaces
  if (variant === 'compact') {
    return (
      <Button
        onClick={handleTopUp}
        variant="gradient"
        gradient={{ from: 'yellow.4', to: 'orange.5' }}
        size={size}
        leftSection={<IconPlus size={16} />}
        className={className}
        radius="md"
      >
        {btnLabel}
      </Button>
    );
  }

  // Banner variant for prominent placement
  if (variant === 'banner' || asBanner) {
    return (
      <Card
        className={`${classes.bannerCard} ${className || ''}`}
        padding="md"
        radius="md"
        withBorder
      >
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon
              size="lg"
              variant="gradient"
              gradient={{ from: 'yellow.4', to: 'orange.5' }}
              radius="md"
            >
              <IconBolt fill="currentColor" size={24} />
            </ThemeIcon>
            <div style={{ flex: 1 }}>
              <Text size="sm" fw={600} className={classes.bannerTitle}>
                {message || 'Running low on Buzz?'}
              </Text>
              <Text size="xs" c="dimmed">
                Top up now to keep creating and exploring
              </Text>
            </div>
          </Group>
          <Button
            onClick={handleTopUp}
            variant="gradient"
            gradient={{ from: 'yellow.4', to: 'orange.5' }}
            size="sm"
            leftSection={<IconPlus size={16} />}
            radius="md"
          >
            {btnLabel}
          </Button>
        </Group>
      </Card>
    );
  }

  // Full variant (default) - complete card
  return (
    <Card className={`${classes.topUpCard} ${className || ''}`} padding="lg" radius="md" withBorder>
      <Stack gap="md">
        {/* Header with icon */}
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon
            size="xl"
            variant="gradient"
            gradient={{ from: 'yellow.4', to: 'orange.5' }}
            radius="md"
            className={classes.topUpIcon}
          >
            <IconBolt size={28} />
          </ThemeIcon>
          <div style={{ flex: 1 }}>
            <Text size="lg" fw={700} className={classes.topUpTitle}>
              {message || 'Boost Your Buzz'}
            </Text>
            <Text size="sm" c="dimmed">
              Get more Buzz to unlock all features
            </Text>
          </div>
          <Badge
            variant="light"
            color="yellow"
            size="sm"
            leftSection={<IconTrendingUp size={12} />}
            className={classes.topUpBadge}
          >
            Popular
          </Badge>
        </Group>

        {/* Current balance (if enabled) */}
        {showBalance && (
          <Card className={classes.balanceCard} padding="sm" radius="sm">
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm" c="dimmed">
                Current Balance:
              </Text>
              <Group gap="sm">
                <UserBuzz
                  accountId={accountId}
                  accountType="user"
                  textSize="sm"
                  withAbbreviation={false}
                />
                <UserBuzz
                  accountId={accountId}
                  accountType="generation"
                  textSize="sm"
                  withAbbreviation={false}
                />
              </Group>
            </Group>
          </Card>
        )}

        {/* Benefits */}
        <div className={classes.benefitsList}>
          <Text size="xs" c="dimmed" mb="xs">
            With more Buzz you can:
          </Text>
          <Group gap="md" wrap="wrap">
            <Text size="xs" c="yellow.6" fw={500}>
              • Generate Images
            </Text>
            <Text size="xs" c="yellow.6" fw={500}>
              • Train Models
            </Text>
            <Text size="xs" c="yellow.6" fw={500}>
              • Support Creators
            </Text>
          </Group>
        </div>

        {/* CTA Button */}
        <Button
          onClick={handleTopUp}
          variant="gradient"
          gradient={{ from: 'yellow.4', to: 'orange.5' }}
          size={size}
          leftSection={<IconPlus size={18} />}
          fullWidth
          className={classes.topUpButton}
          radius="md"
        >
          Top Up Buzz Now
        </Button>

        {/* Footer */}
        <Center>
          <Text size="xs" c="dimmed" ta="center">
            Quick • Secure • Instant
          </Text>
        </Center>
      </Stack>
    </Card>
  );
}
