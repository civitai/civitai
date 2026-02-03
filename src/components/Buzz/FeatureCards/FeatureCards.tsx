import type { ButtonProps } from '@mantine/core';
import { Button, List, Paper, Stack, Text, Title, Group, Tooltip } from '@mantine/core';
import {
  IconArrowRight,
  IconBarbell,
  IconBarcode,
  IconBrush,
  IconCoin,
  IconCoins,
  IconHighlight,
  IconMoneybag,
  IconShoppingBag,
  IconShoppingCart,
  IconInfoCircle,
} from '@tabler/icons-react';
import React from 'react';
import type { MouseEvent } from 'react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { getAccountTypeLabel } from '~/utils/buzz';
import { WatchAdButton } from '~/components/WatchAdButton/WatchAdButton';
import { Currency } from '~/shared/utils/prisma/enums';
import dynamic from 'next/dynamic';
import classes from './FeatureCards.module.scss';
import type { BuzzAccountType, BuzzSpendType } from '~/shared/constants/buzz.constants';
const RedeemCodeModal = dynamic(() =>
  import('~/components/RedeemableCode/RedeemCodeModal').then((x) => x.RedeemCodeModal)
);

const getEarnings = (
  accountType: BuzzAccountType,
  buzzConfig?: ReturnType<typeof useBuzzCurrencyConfig>
): (FeatureCardProps & { key: string })[] =>
  [
    // {
    //   key: 'referrals',
    //   icon: <IconUsers size={32} />,
    //   title: 'Referrals',
    //   description: 'You & your friends can earn more Buzz!',
    //   btnProps: {
    //     href: '/user/account#referrals',
    //     children: 'Invite a friend',
    //   },
    // },
    {
      key: 'bounties',
      icon: <IconMoneybag size={32} />,
      title: 'Bounties',
      description: 'Submit work to a bounty to win Buzz',
      btnProps: {
        href: '/bounties',
        children: 'Learn more',
        color: buzzConfig?.color,
      },
    },
    {
      key: 'purchase',
      icon: <IconCoin size={32} />,
      title: 'Purchase',
      description: 'Purchase Buzz directly',
      btnProps: {
        href: '/purchase/buzz',
        children: 'Buy now',
        color: buzzConfig?.color,
      },
    },
    {
      key: 'tips',
      icon: <IconCoins size={32} />,
      title: 'Get tipped',
      description: 'Create awesome content!',
      btnProps: {
        href: '/posts/create',
        children: 'Create post',
        color: buzzConfig?.color,
      },
    },
    {
      disabled: accountType !== 'yellow',
      key: 'redeem',
      icon: <IconBarcode size={32} />,
      title: 'Redeem a code',
      description: 'Purchased a Buzz card? Redeem it to get your Buzz!',
      btnProps: {
        onClick: () => {
          dialogStore.trigger({ component: RedeemCodeModal });
        },
        children: 'Redeem code',
        color: buzzConfig?.color,
      },
    },
  ].filter((item) => !item.disabled);

export const EarningBuzz = ({ asList, withCTA, accountType = 'yellow' }: Props) => {
  const buzzConfig = useBuzzCurrencyConfig(accountType);
  const earnings = getEarnings(accountType, buzzConfig);
  const accountTypeLabel = getAccountTypeLabel(accountType);

  return (
    <Stack gap={20}>
      <Stack gap={4}>
        <Group gap="xs" align="center">
          <Title order={2} style={{ color: buzzConfig.color }}>
            Earn {accountTypeLabel} Buzz
          </Title>
        </Group>
        <Text c="dimmed" size="md">
          Multiple ways to get {accountTypeLabel} Buzz and power your creativity
        </Text>
      </Stack>
      {asList ? (
        <FeatureList data={earnings} />
      ) : (
        <ContainerGrid2 gutter={20}>
          {earnings.map(({ key, ...item }) => (
            <ContainerGrid2.Col key={key} span={{ base: 12, sm: 4, md: 3 }}>
              <FeatureCard {...item} withCTA={item.withCTA ?? withCTA} />
            </ContainerGrid2.Col>
          ))}
        </ContainerGrid2>
      )}
    </Stack>
  );
};

const getSpendings = ({ userId }: { userId?: number }): (FeatureCardProps & { key: string })[] => [
  {
    key: 'train',
    icon: <IconBarbell size={32} />,
    title: 'Train',
    description: 'Train your own LoRAs to generate images',
    btnProps: {
      href: '/models/train',
      children: 'Train now',
    },
  },
  {
    key: 'generate',
    icon: <IconBrush size={32} />,
    title: 'Generate',
    description: 'Generate Flux and Pony images',
    btnProps: {
      onClick: () => generationGraphPanel.open(),
      children: 'Generate',
    },
  },
  {
    key: 'bounty',
    icon: <IconMoneybag size={32} />,
    title: 'Post a bounty',
    description: 'Get others to help solve your problem',
    btnProps: {
      href: '/bounties/create',
      children: 'Post a bounty',
      rightSection: <IconArrowRight size={14} />,
    },
  },
  {
    key: 'showcase',
    icon: <IconHighlight size={32} />,
    title: 'Get showcased',
    description: 'Get your content featured on our homepage',
    btnProps: {
      target: '_blank',
      rel: 'noreferrer nofollow',
      href: `https://civitai.retool.com/form/cdf269fb-c9b1-4da4-8601-6367c2358a36?userId=${
        userId as number
      }`,
      children: 'Apply Now',
      rightSection: <IconArrowRight size={14} />,
    },
    withCTA: !!userId, // Only show if userId is available
  },
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
  {
    key: 'merch',
    icon: <IconShoppingCart size={32} />,
    title: 'Shop merch',
    description: 'Tons of fun stickers to choose from...',
    btnProps: {
      disabled: true,
      children: 'COMING SOON',
    },
  },
];

export const SpendingBuzz = ({ asList, withCTA }: Props) => {
  const currentUser = useCurrentUser();
  // const open = useGenerationStore((state) => state.open);
  const spendings = getSpendings({ userId: currentUser?.id });

  return (
    <Stack gap={20}>
      <Stack gap={4}>
        <Title order={2}>Spend Buzz</Title>
        <Text>Got some Buzz? Here&rsquo;s what you can do with it</Text>
      </Stack>
      {asList ? (
        <FeatureList data={spendings} />
      ) : (
        <ContainerGrid2 gutter={20}>
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

type Props = { asList?: boolean; withCTA?: boolean; accountType?: BuzzSpendType };

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
              component="a"
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
    <List
      listStyleType="none"
      spacing={8}
      icon={<CurrencyIcon currency="BUZZ" size={20} style={{ verticalAlign: 'middle' }} />}
    >
      {data.map((item, index) => (
        <List.Item key={index}>
          <Stack gap={0}>
            <Text fw={590} tt="capitalize">
              {item.title}
              {item.btnProps.disabled ? ' (Coming Soon)' : ''}
            </Text>
            <Text c="dimmed">{item.description}</Text>
          </Stack>
        </List.Item>
      ))}
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
    </Stack>
  );
};
