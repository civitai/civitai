import {
  Stack,
  Card,
  Title,
  Text,
  Center,
  createStyles,
  Group,
  Select,
  Button,
  ButtonProps,
  ThemeIconVariant,
} from '@mantine/core';
import {
  IconAdCircleOff,
  IconBolt,
  IconChevronDown,
  IconCloud,
  IconVideo,
  IconPhotoPlus,
} from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { benefitIconSize, BenefitItem, PlanBenefitList } from '~/components/Stripe/PlanBenefitList';
import { CurrencyBadge } from '../Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import { containerQuery } from '~/utils/mantine-css-helpers';
import type { StripePlan, StripeSubscription } from '~/server/services/stripe.service';
import { useState } from 'react';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { getStripeCurrencyDisplay } from '~/utils/string-helpers';
import { ProductMetadata } from '~/server/schema/stripe.schema';
import { isDefined } from '~/utils/type-guards';
import { formatKBytes, numberWithCommas } from '~/utils/number-helpers';
import { constants } from '~/server/common/constants';
import { shortenPlanInterval } from '~/components/Stripe/stripe.utils';
import { ManageSubscriptionButton } from '~/components/Stripe/ManageSubscriptionButton';
import { FeatureAccess } from '~/server/services/feature-flags.service';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { DowngradeFeedbackModal } from '~/components/Stripe/DowngradeFeedbackModal';

type PlanCardProps = {
  product: StripePlan;
  subscription?: StripeSubscription | null;
};

const subscribeBtnProps: Record<string, Partial<ButtonProps>> = {
  upgrade: {
    color: 'blue',
    variant: 'filled',
  },
  downgrade: {
    color: 'gray',
    variant: 'filled',
  },
  active: {
    color: 'gray',
    variant: 'outline',
  },
  subscribe: {
    color: 'blue',
    variant: 'filled',
  },
} as const;

export function PlanCard({ product, subscription }: PlanCardProps) {
  const features = useFeatureFlags();
  const hasActiveSubscription = subscription?.status === 'active';
  const isActivePlan = hasActiveSubscription && subscription?.product?.id === product.id;
  const { classes } = useStyles();
  const meta = (product.metadata ?? {}) as ProductMetadata;
  const subscriptionMeta = (subscription?.product.metadata ?? {}) as ProductMetadata;
  const isUpgrade =
    hasActiveSubscription &&
    constants.memberships.tierOrder.indexOf(meta.tier) >
      constants.memberships.tierOrder.indexOf(subscriptionMeta.tier ?? '');
  const isDowngrade =
    hasActiveSubscription &&
    constants.memberships.tierOrder.indexOf(meta.tier) <
      constants.memberships.tierOrder.indexOf(subscriptionMeta.tier ?? '');
  const { benefits, image } = getPlanDetails(product, features) ?? {};
  const defaultPriceId = isActivePlan
    ? subscription?.price.id ?? product.defaultPriceId
    : product.defaultPriceId;
  const [priceId, setPriceId] = useState<string | null>(defaultPriceId);
  const price = product.prices.find((p) => p.id === priceId) ?? product.prices[0];
  const btnProps = isActivePlan
    ? subscribeBtnProps.active
    : isUpgrade
    ? subscribeBtnProps.upgrade
    : isDowngrade
    ? subscribeBtnProps.downgrade
    : subscribeBtnProps.subscribe;

  return (
    <Card className={classes.card}>
      <Stack justify="space-between" style={{ height: '100%' }}>
        <Stack>
          <Stack spacing="md" mb="md">
            <Title className={classes.title} order={2} align="center" mb="sm">
              {product.name}
            </Title>
            {image && (
              <Center>
                <EdgeMedia src={image} width={128} className={classes.image} />
              </Center>
            )}
            <Group position="center" spacing={4}>
              <Text className={classes.price} align="center" size={18} weight={500} lh={1}>
                {getStripeCurrencyDisplay(price.unitAmount, price.currency)}
              </Text>
              <Select
                data={product.prices.map((p) => ({ label: p.currency, value: p.id }))}
                value={priceId}
                onChange={setPriceId}
                variant="unstyled"
                w={50}
                rightSection={<IconChevronDown size={14} />}
                rightSectionWidth={20}
                styles={(theme) => ({
                  root: {
                    marginTop: 2,
                    borderBottom: `2px solid ${theme.colors.blue[theme.fn.primaryShade()]}`,
                  },
                  input: {
                    textTransform: 'uppercase',
                    textAlign: 'left',
                    height: 20,
                    minHeight: 20,
                  },
                  item: {
                    textTransform: 'uppercase',
                    padding: '0 4px',
                    textAlign: 'center',
                  },
                  rightSection: {
                    marginRight: 0,
                  },
                })}
              />
              <Text className={classes.price} align="center" color="dimmed">
                / {shortenPlanInterval(price.interval)}
              </Text>
            </Group>

            {priceId && (
              <>
                {isActivePlan ? (
                  <ManageSubscriptionButton>
                    <Button radius="xl" {...btnProps}>
                      Manage your Membership
                    </Button>
                  </ManageSubscriptionButton>
                ) : isDowngrade ? (
                  <Button
                    radius="xl"
                    {...btnProps}
                    onClick={() => {
                      dialogStore.trigger({
                        component: DowngradeFeedbackModal,
                        props: {
                          priceId,
                          upcomingVaultSizeKb: meta.vaultSizeKb,
                          fromTier: subscriptionMeta.tier,
                          toTier: meta.tier,
                        },
                      });
                    }}
                  >
                    Downgrade to {meta?.tier}
                  </Button>
                ) : (
                  <SubscribeButton priceId={priceId}>
                    <Button radius="xl" {...btnProps}>
                      {isActivePlan
                        ? `You are ${meta?.tier}`
                        : isUpgrade
                        ? `Upgrade to ${meta?.tier}`
                        : isDowngrade
                        ? `Downgrade to ${meta?.tier}`
                        : `Subscribe to ${meta?.tier}`}
                    </Button>
                  </SubscribeButton>
                )}
              </>
            )}
          </Stack>
          {benefits && <PlanBenefitList benefits={benefits} />}
          {product.description && <Text>{product.description}</Text>}
        </Stack>
      </Stack>
    </Card>
  );
}

export const getPlanDetails: (
  product: Pick<StripePlan, 'metadata' | 'name'>,
  features: FeatureAccess
) => PlanMeta = (product: Pick<StripePlan, 'metadata' | 'name'>, features: FeatureAccess) => {
  const metadata = (product.metadata ?? {}) as ProductMetadata;
  const planMeta = {
    name: product?.name ?? 'Supporter Tier',
    image:
      metadata?.badge ?? constants.memberships.badges[metadata.tier] ?? constants.supporterBadge,
    benefits: [
      {
        icon: <IconBolt size={benefitIconSize} />,
        iconColor: 'yellow',
        iconVariant: 'light' as ThemeIconVariant,
        content: (
          <Text>
            <Text span color="yellow.7">
              {numberWithCommas(metadata?.monthlyBuzz ?? 3000)} Buzz for spending
            </Text>
          </Text>
        ),
      },
      {
        icon: <IconPhotoPlus size={benefitIconSize} />,
        iconColor: 'blue',
        content: <Text>{metadata.generationLimit ?? 3}x more generations per day</Text>,
        variant: 'light' as ThemeIconVariant,
      },
      metadata.vaultSizeKb && features.vault
        ? {
            content: (
              <Text>
                {formatKBytes(metadata.vaultSizeKb)}{' '}
                <Text
                  variant="link"
                  td="underline"
                  component="a"
                  href="/product/vault"
                  target="_blank"
                >
                  Civitai Vault storage
                </Text>
              </Text>
            ),
            icon: <IconCloud size={benefitIconSize} />,
            iconColor: 'green',
            iconVariant: 'light' as ThemeIconVariant,
          }
        : undefined,
      metadata.animatedBadge
        ? {
            content: (
              <Text color="blue">
                Unique{' '}
                <Text component="span" weight="bold">
                  Animated
                </Text>{' '}
                Supported Badge each month
              </Text>
            ),
            icon: <IconVideo size={benefitIconSize} />,
            iconColor: 'blue',
            iconVariant: 'light' as ThemeIconVariant,
          }
        : undefined,
    ].filter(isDefined),
  };

  return planMeta;
};

type PlanMeta = {
  name: string;
  image: string;
  benefits: BenefitItem[];
};

const useStyles = createStyles((theme) => ({
  card: {
    height: '100%',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
  },
  image: {
    [containerQuery.smallerThan('sm')]: {
      width: 96,
      marginBottom: theme.spacing.xs,
    },
  },
  title: {
    [containerQuery.smallerThan('sm')]: {
      fontSize: 20,
    },
  },
  price: {
    [containerQuery.smallerThan('sm')]: {
      fontSize: 16,
    },
  },
}));
