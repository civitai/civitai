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
} from '@mantine/core';
import {
  IconAdCircleOff,
  IconBolt,
  IconChevronDown,
  IconCloud,
  IconVideo,
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
import { formatKBytes } from '~/utils/number-helpers';
import { constants } from '~/server/common/constants';

type PlanCardProps = {
  product: StripePlan;
  subscription?: StripeSubscription | null;
};

export function PlanCard({ product, subscription }: PlanCardProps) {
  const isActivePlan = subscription?.product?.id === product.id;
  const { classes } = useStyles();
  const meta = (product.metadata ?? {}) as ProductMetadata;
  const { benefits, image } = getPlanDetails(product) ?? {};
  const defaultPriceId = isActivePlan
    ? subscription?.price.id ?? product.defaultPriceId
    : product.defaultPriceId;
  const [priceId, setPriceId] = useState<string | null>(defaultPriceId);
  const price = product.prices.find((p) => p.id === priceId) ?? product.prices[0];
  const canSubscribe = (!subscription || !!subscription.canceledAt) && priceId;

  return (
    <Card withBorder style={{ height: '100%' }}>
      <Stack justify="space-between" style={{ height: '100%' }}>
        <Stack>
          <Stack spacing={0} mb="md">
            {image && (
              <Center>
                <EdgeMedia src={image} width={128} className={classes.image} />
              </Center>
            )}
            <Title className={classes.title} order={2} align="center" mb="sm">
              {product.name}
            </Title>
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
            </Group>
            <Text className={classes.price} align="center" color="dimmed">
              per {price.interval}
            </Text>
          </Stack>
          {benefits && <PlanBenefitList benefits={benefits} />}
          {product.description && <Text>{product.description}</Text>}
        </Stack>
        {canSubscribe && (
          <SubscribeButton priceId={priceId}>
            <Button>Subscribe</Button>
          </SubscribeButton>
        )}
      </Stack>
    </Card>
  );
}

export const getPlanDetails: (product: StripePlan) => PlanMeta = (product: StripePlan) => {
  const metadata = (product.metadata ?? {}) as ProductMetadata;
  const planMeta = {
    name: product?.name ?? 'Supporter Tier',
    image: metadata?.badge ?? constants.badges[metadata.tier] ?? constants.supporterBadge,
    benefits: [
      { content: 'Ad free browsing', icon: <IconAdCircleOff size={benefitIconSize} /> },
      { content: 'Civitai Link' },
      { content: 'Civitai Archive' },
      { content: 'Unique Supporter Badge each month' },
      { content: 'Can equip special cosmetics' },
      { content: 'Exclusive Discord channels' },
      { content: 'Early access content' },
      { content: 'Early access to new features' },
      {
        icon: <IconBolt size={benefitIconSize} />,
        iconColor: 'yellow',
        content: (
          <Text>
            <Text span>
              <CurrencyBadge currency={Currency.BUZZ} unitAmount={metadata?.monthlyBuzz ?? 5000} />{' '}
              each month
            </Text>
          </Text>
        ),
      },
      metadata.vaultSizeKb
        ? {
            content: `Vault size: ${formatKBytes(metadata.vaultSizeKb, 0)}`,
            icon: <IconCloud />,
            iconColor: 'yellow',
          }
        : undefined,
      metadata.animatedBadge
        ? {
            content: (
              <Text>
                Unique{' '}
                <Text component="span" weight="bold">
                  Animated
                </Text>{' '}
                Supported Badge each month
              </Text>
            ),
            icon: <IconVideo />,
            iconColor: 'yellow',
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
