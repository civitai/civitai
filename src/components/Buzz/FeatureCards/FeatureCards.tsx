import type { ButtonProps } from '@mantine/core';
import { Button, List, Paper, SimpleGrid, Stack, Text, ThemeIcon, Title, Group, Tooltip } from '@mantine/core';
import {
  IconArrowRight,
  IconBarbell,
  IconBrush,
  IconCoin,
  IconMessageCircle,
  IconMoneybag,
  IconShoppingBag,
  IconInfoCircle,
  IconTrophy,
} from '@tabler/icons-react';
import React, { useMemo } from 'react';
import type { MouseEvent } from 'react';
import Link from 'next/link';
import dayjs from '~/shared/utils/dayjs';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { getAccountTypeLabel } from '~/utils/buzz';
import { WatchAdButton } from '~/components/WatchAdButton/WatchAdButton';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { Currency } from '~/shared/utils/prisma/enums';
import classes from './FeatureCards.module.scss';
import type { BuzzAccountType, BuzzSpendType } from '~/shared/constants/buzz.constants';

const getEarnings = (
  accountType: BuzzAccountType,
  buzzConfig?: ReturnType<typeof useBuzzCurrencyConfig>
): (FeatureCardProps & { key: string })[] => {
  const isGreen = accountType === 'green';
  return [
    {
      key: 'purchase',
      icon: <IconCoin size={32} />,
      title: 'Purchase',
      description: isGreen
        ? 'Top up your Buzz balance any time.'
        : 'Buy Buzz with your favorite crypto. Sent to your personalized deposit address.',
      btnProps: {
        onClick: async () => {
          const BuyBuzzModal = (await import('~/components/Modals/BuyBuzzModal')).default;
          dialogStore.trigger({ component: BuyBuzzModal });
        },
        children: 'Buy Buzz',
        color: buzzConfig?.color,
      },
    },
    {
      key: 'challenges',
      icon: <IconTrophy size={32} />,
      title: 'Challenges',
      description: 'Enter themed contests. Generate using the featured model, AI picks the winners.',
      btnProps: {
        href: '/challenges',
        children: 'View challenges',
        color: buzzConfig?.color,
      },
    },
    ...(!isGreen
      ? [
          {
            key: 'bounties',
            icon: <IconMoneybag size={32} />,
            title: 'Bounties',
            description:
              'Earn Buzz by completing creative requests from other users, or post your own.',
            btnProps: {
              href: '/bounties',
              children: 'View bounties',
              color: buzzConfig?.color,
            },
          },
        ]
      : []),
    {
      key: 'beggars-board',
      icon: <IconMessageCircle size={32} />,
      title: 'Buzz Beggars Board',
      description: 'Post your images to get tipped Buzz by the community and featured on the homepage',
      btnProps: {
        href: '/collections/3870938',
        children: 'Visit board',
        color: buzzConfig?.color,
      },
    },
  ].filter((item) => !(item as FeatureCardProps).disabled);
};

export const EarningBuzz = ({ asList, withCTA, accountType = 'yellow', hideHeader, columns }: Props) => {
  const buzzConfig = useBuzzCurrencyConfig(accountType);
  const earnings = getEarnings(accountType, buzzConfig);
  const accountTypeLabel = getAccountTypeLabel(accountType);

  return (
    <Stack gap="md">
      {!hideHeader && (
        <Stack gap={4}>
          <Group gap="xs" align="center">
            <Title order={2} style={{ color: buzzConfig.color }}>
              Get {accountTypeLabel} Buzz
            </Title>
          </Group>
          <Text c="dimmed" size="md">
            Multiple ways to get {accountTypeLabel} Buzz and power your creativity
          </Text>
        </Stack>
      )}
      {asList ? (
        <FeatureList data={earnings} />
      ) : (
        columns === 2 ? (
          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md">
            {earnings.map(({ key, ...item }) => (
              <FeatureCard key={key} {...item} withCTA={item.withCTA ?? withCTA} />
            ))}
          </SimpleGrid>
        ) : (
          <ContainerGrid2 gutter="md">
            {earnings.map(({ key, ...item }) => (
              <ContainerGrid2.Col key={key} span={{ base: 12, sm: 4, md: 3 }}>
                <FeatureCard {...item} withCTA={item.withCTA ?? withCTA} />
              </ContainerGrid2.Col>
            ))}
          </ContainerGrid2>
        )
      )}
    </Stack>
  );
};

const getSpendings = ({
  accountType,
}: {
  accountType?: BuzzSpendType;
}): (FeatureCardProps & { key: string })[] => {
  const isGreen = accountType === 'green';
  return [
    {
      key: 'generate',
      icon: <IconBrush size={32} />,
      title: 'Generate',
      description: 'Generate images and videos using a wide variety of AI models',
      btnProps: {
        onClick: () => generationGraphPanel.open(),
        children: 'Generate',
      },
    },
    {
      key: 'train',
      icon: <IconBarbell size={32} />,
      title: 'Customize AI',
      description: 'Train AI to fine-tune its behavior and capture your style, subject, or concept',
      btnProps: {
        href: '/models/train',
        children: 'Train now',
      },
    },
    ...(!isGreen
      ? [
          {
            key: 'bounty',
            icon: <IconMoneybag size={32} />,
            title: 'Post a bounty',
            description: 'Pay community creators to make what you need.',
            btnProps: {
              href: '/bounties/create',
              children: 'Post a bounty',
              rightSection: <IconArrowRight size={14} />,
            },
          },
        ]
      : []),
    {
      key: 'badges',
      icon: <IconShoppingBag size={32} />,
      title: 'Shop badges and cosmetics',
      description: 'Make your profile stand out!',
      btnProps: {
        href: '/shop',
        children: 'Get some!',
        rightSection: <IconArrowRight size={14} />,
      },
    },
  ];
};

export const SpendingBuzz = ({ asList, withCTA, accountType }: Props) => {
  const spendings = getSpendings({ accountType });

  return (
    <Stack gap="md">
      <Stack gap={4}>
        <Title order={3}>What&rsquo;s Buzz for?</Title>
        <Text>Here&rsquo;s what you can do with Buzz on Civitai</Text>
      </Stack>
      {asList ? (
        <FeatureList data={spendings} />
      ) : (
        <ContainerGrid2 gutter="md">
          {spendings.map(({ key, ...item }) => (
            <ContainerGrid2.Col key={key} span={{ base: 12, sm: 4, md: 3 }}>
              <FeatureCard {...item} withCTA={item.withCTA ?? withCTA} />
            </ContainerGrid2.Col>
          ))}
        </ContainerGrid2>
      )}
    </Stack>
  );
};

type Props = { asList?: boolean; withCTA?: boolean; accountType?: BuzzSpendType; hideHeader?: boolean; columns?: 2 | 4 };

type FeatureCardProps = {
  title: string;
  description: string;
  icon: React.ReactNode;
  btnProps: ButtonProps & {
    href?: string;
    component?: 'a' | 'button';
    target?: string;
    rel?: string;
    onClick?: (e: MouseEvent<HTMLElement>) => void;
  };
  withCTA?: boolean;
  disabled?: boolean;
};

export const FeatureCard = ({ title, description, icon, btnProps, withCTA }: FeatureCardProps) => {
  if (!withCTA && btnProps.disabled) return null;

  const buzzColor = btnProps.color || '#f59f00'; // Default buzz orange color
  // Convert hex to RGB for CSS variable
  const hexToRgb = (hex: string) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`
      : '245, 159, 0'; // Default buzz orange RGB
  };

  return (
    <Paper
      withBorder
      className={classes.featureCard}
      h="100%"
      radius="md"
      p={0}
      style={
        {
          '--buzz-color': hexToRgb(buzzColor),
        } as React.CSSProperties
      }
    >
      <Stack gap={0} h="100%">
        {/* Icon Section */}
        <div className={classes.iconSection}>
          <div className={classes.iconWrapper}>{icon}</div>
        </div>

        {/* Content Section */}
        <Stack gap="sm" p="lg" align="center" h="100%">
          <Text fw={600} size="lg" align="center" tt="capitalize" lh={1.3}>
            {title}
          </Text>
          <Text c="dimmed" align="center" size="sm" lh={1.4}>
            {description}
          </Text>

          {withCTA && (
            <Button
              component={(btnProps.href && !btnProps.target ? Link : btnProps.href ? 'a' : 'button') as 'a'}
              mt="auto"
              w="100%"
              variant="gradient"
              gradient={{ from: btnProps.color || 'blue', to: btnProps.color || 'cyan', deg: 45 }}
              radius="md"
              size="sm"
              fw={600}
              {...btnProps}
            />
          )}
        </Stack>
      </Stack>
    </Paper>
  );
};

export const FeatureList = ({ data }: { data: FeatureCardProps[] }) => {
  return (
    <List listStyleType="none" spacing={14}>
      {data.map((item, index) => {
        const iconElement = React.isValidElement<{ size?: number }>(item.icon)
          ? React.cloneElement(item.icon, { size: 18 })
          : item.icon;
        return (
          <List.Item
            key={index}
            icon={
              <ThemeIcon size={32} radius="xl" variant="light" color="gray">
                {iconElement}
              </ThemeIcon>
            }
          >
            <Stack gap={0}>
              <Text fw={590} tt="capitalize" lh={1.2}>
                {item.title}
                {item.btnProps.disabled ? ' (Coming Soon)' : ''}
              </Text>
              <Text c="dimmed" size="sm" lh={1.3}>
                {item.description}
              </Text>
            </Stack>
          </List.Item>
        );
      })}
    </List>
  );
};

// Enhanced Rewards List Component
type RewardItem = {
  type: string;
  accountType: BuzzSpendType;
  awardAmount: number;
  description?: string;
  triggerDescription?: string;
  tooltip?: string;
  awarded: number;
  cap?: number;
  interval?: string;
};

type RewardsListProps = {
  rewards: RewardItem[];
  accountType: BuzzSpendType;
  rewardsMultiplier: number;
  onAccountTypeChange?: (accountType: BuzzSpendType) => void;
};

export const RewardsList = ({
  rewards,
  accountType,
  onAccountTypeChange,
}: Omit<RewardsListProps, 'rewardsMultiplier'>) => {
  const buzzConfig = useBuzzCurrencyConfig(accountType);
  const nextReset = useMemo(() => dayjs.utc().add(1, 'day').startOf('day').toDate(), []);

  // Convert hex to RGB for CSS variable
  const hexToRgb = (hex: string) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`
      : '245, 159, 0';
  };

  if (rewards.length === 0) {
    return (
      <Stack gap="md" align="center" py="xl">
        <Text c="dimmed" size="lg" fw={500}>
          No rewards available for {getAccountTypeLabel(accountType)} Buzz at the moment
        </Text>
        <Text size="sm" c="dimmed">
          Check out the{' '}
          <Text
            component="button"
            c="blue.4"
            td="underline"
            onClick={() => onAccountTypeChange?.('blue')}
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          >
            Blue Buzz rewards
          </Text>{' '}
          available.
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="xs">
      {rewards.map((reward) => {
        const hasAwarded = reward.awarded !== -1;
        const awardedAmountPercent = reward.cap && hasAwarded ? reward.awarded / reward.cap : 0;
        const isCompleted = awardedAmountPercent >= 1;

        return (
          <Paper
            key={reward.type}
            className={`${classes.rewardCard} ${isCompleted ? classes.rewardCardCompleted : ''}`}
            style={
              {
                '--buzz-color': hexToRgb(buzzConfig.color),
                '--progress-width': `${awardedAmountPercent * 100}%`,
              } as React.CSSProperties
            }
          >
            <Group justify="space-between" align="center" wrap="nowrap">
              {/* Main content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <Group gap="xs" align="center" wrap="nowrap">
                  <CurrencyIcon size={16} currency={Currency.BUZZ} type={accountType} />
                  <Text size="sm" fw={600} c={`rgb(${hexToRgb(buzzConfig.color)})`}>
                    {reward.awardAmount.toLocaleString()}
                  </Text>
                  <Text fw={500} size="sm" style={{ flex: 1 }} truncate>
                    {reward.triggerDescription ?? reward.description}
                  </Text>
                  {reward.tooltip && (
                    <Tooltip label={reward.tooltip} maw={250} multiline withArrow>
                      <IconInfoCircle size={14} style={{ color: 'var(--mantine-color-dimmed)' }} />
                    </Tooltip>
                  )}
                </Group>

                {/* Progress info */}
                {reward.cap && hasAwarded && (
                  <Group gap="xs" align="center" mt={4}>
                    <Text size="xs" c="dimmed">
                      {reward.awarded.toLocaleString()} / {reward.cap.toLocaleString()}
                    </Text>
                    <div
                      className={`${classes.rewardProgress} ${
                        isCompleted ? classes.rewardProgressCompleted : ''
                      }`}
                      style={{ flex: 1, minWidth: 60 }}
                    />
                    <Text size="xs" c="dimmed" fw={500}>
                      {Math.round(awardedAmountPercent * 100)}%
                    </Text>
                  </Group>
                )}
                {reward.cap && !hasAwarded && reward.interval && (
                  <Text size="xs" c="dimmed">
                    {reward.cap.toLocaleString()} / {reward.interval}
                  </Text>
                )}
              </div>

              {/* Watch ad button */}
              {reward.type === 'adWatched' && (
                <WatchAdButton
                  size="compact-xs"
                  disabled={isCompleted}
                  className={classes.watchAdButton}
                />
              )}
            </Group>
          </Paper>
        );
      })}
      <Text size="xs" c="dimmed" ta="right">
        <Tooltip label="Daily Buzz rewards reset at midnight UTC" withArrow>
          <span>
            Resets in <Countdown endTime={nextReset} format="short" />
          </span>
        </Tooltip>
      </Text>
    </Stack>
  );
};
