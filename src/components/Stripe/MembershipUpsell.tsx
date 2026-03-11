import {
  Text,
  Stack,
  Group,
  Button,
  Anchor,
  Badge,
  Collapse,
  Loader,
  Center,
  Card,
  Title,
  ThemeIcon,
  Box,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconBolt, IconCheck, IconChevronDown, IconDiamond, IconStar } from '@tabler/icons-react';
import { capitalize } from 'lodash-es';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { formatPriceForDisplay, numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { MembershipUpgradeModal } from '~/components/Stripe/MembershipChangePrevention';
import { dialogStore } from '~/components/Dialog/dialogStore';
import classes from './MembershipUpsell.module.scss';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';

export const MembershipUpsell = ({
  buzzAmount,
  onClick,
}: {
  buzzAmount: number;
  onClick?: () => void;
}) => {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const paymentProvider = usePaymentProvider();
  const { data: products = [], isLoading: productsLoading } = trpc.subscriptions.getPlans.useQuery(
    { paymentProvider },
    { enabled: !!currentUser }
  );

  const { subscription, subscriptionLoading } = useActiveSubscription();

  if (productsLoading || subscriptionLoading || !currentUser) {
    return (
      <Card className={classes.membershipCard} padding="lg" radius="md">
        <Center w="100%" h={200}>
          <Stack align="center" gap="xs">
            <Loader type="bars" size="md" color="violet.6" />
            <Text size="sm" c="dimmed">
              Loading membership options...
            </Text>
          </Stack>
        </Center>
      </Card>
    );
  }

  const subscriptionMetadata = subscription?.product?.metadata as SubscriptionProductMetadata;

  const targetPlan = products.find((product, index) => {
    const metadata = (product?.metadata ?? {
      monthlyBuzz: 0,
      tier: 'free',
    }) as SubscriptionProductMetadata;
    if (
      subscription &&
      subscriptionMetadata &&
      constants.memberships.tierOrder.indexOf(subscriptionMetadata.tier) >=
        constants.memberships.tierOrder.indexOf(metadata.tier)
    ) {
      return false;
    }

    return (metadata.monthlyBuzz ?? 0) >= buzzAmount || index === products.length - 1;
  });

  if (!targetPlan) {
    return null;
  }

  const metadata = (targetPlan.metadata ?? {}) as SubscriptionProductMetadata;
  const planMeta = getPlanDetails(targetPlan, features);
  const { image, benefits } = planMeta;

  const targetTier = metadata.tier ?? 'free';
  const unitAmount = targetPlan.price.unitAmount ?? 0;
  const priceId = targetPlan.defaultPriceId ?? '';

  return (
    <Card className={classes.membershipCard} padding="md" radius="md">
      <Stack gap="sm">
        {/* Header with badge */}
        <Group justify="space-between" align="flex-start">
          <Badge variant="light" size="md" color="grape" className={classes.badge}>
            <Group gap={4}>
              <IconStar size={16} fill="currentColor" />
              <Text tt="uppercase" fw={600} size="xs">
                Pro
              </Text>
            </Group>
          </Badge>

          {image && (
            <Box className={classes.imageWrapper}>
              <EdgeMedia src={image} width={50} />
            </Box>
          )}
        </Group>

        {/* Title and icon */}
        <Group gap="sm" align="center">
          <ThemeIcon size={40} radius="xl" className={classes.tierIcon}>
            <IconDiamond size={20} />
          </ThemeIcon>
          <div>
            <Title order={3} className={classes.title} size="md">
              {capitalize(targetTier)} Membership
            </Title>
            <Text className={classes.subtitle} size="xs" c="dimmed">
              {subscription ? 'Upgrade to unlock more:' : 'Get more with membership:'}
            </Text>
          </div>
        </Group>

        {/* Benefits - Compact list with expand */}
        <BenefitsList
          benefits={benefits}
          multiplier={(metadata.purchasesMultiplier ?? 1) > 1 ? metadata.purchasesMultiplier! : undefined}
          buzzAmount={buzzAmount}
        />

        {/* CTA Section - Compact */}
        <Stack gap="xs" mt="sm">
          <Group justify="center" gap={4} align="baseline">
            <Text size="lg" fw={700} className={classes.price}>
              ${formatPriceForDisplay(unitAmount, undefined, { decimals: false })}
            </Text>
            <Text size="xs" c="dimmed">
              /month
            </Text>
          </Group>

          {subscription ? (
            <Button
              className={classes.upgradeButton}
              size="sm"
              radius="md"
              fullWidth
              component={features.disablePayments ? 'a' : undefined}
              href={features.disablePayments ? '/pricing' : undefined}
              onClick={
                features.disablePayments
                  ? onClick
                  : () => {
                      onClick?.();
                      dialogStore.trigger({
                        component: MembershipUpgradeModal,
                        props: {
                          priceId,
                          meta: planMeta,
                          price: {
                            id: priceId,
                            interval: 'month',
                          },
                        },
                      });
                    }
              }
            >
              Upgrade Now
            </Button>
          ) : features.disablePayments ? (
            <Button
              href="/pricing"
              className={classes.upgradeButton}
              size="sm"
              radius="md"
              fullWidth
              component="a"
              onClick={onClick}
            >
              Get {capitalize(targetTier)}
            </Button>
          ) : (
            <SubscribeButton priceId={priceId} disabled={features.disablePayments}>
              <Button className={classes.upgradeButton} size="sm" radius="md" fullWidth>
                Get {capitalize(targetTier)}
              </Button>
            </SubscribeButton>
          )}

          <Text size="xs" c="dimmed" ta="center">
            Cancel anytime •{' '}
            <Anchor href="/pricing" size="xs">
              Learn more
            </Anchor>
          </Text>
        </Stack>
      </Stack>
    </Card>
  );
};

function BenefitRow({ content }: { content: string }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <ThemeIcon size={16} radius="xl" color="grape" variant="light">
        <IconCheck size={10} />
      </ThemeIcon>
      <Text className={classes.benefitText} size="xs">
        {content}
      </Text>
    </Group>
  );
}

function BenefitsList({
  benefits,
  multiplier,
  buzzAmount,
}: {
  benefits: { content?: string }[];
  multiplier?: number;
  buzzAmount: number;
}) {
  const [expanded, { toggle }] = useDisclosure(false);
  const filtered = benefits.filter((b) => b.content);
  const visible = filtered.slice(0, 3);
  const remaining = filtered.slice(3);

  const multiplierRow = multiplier ? (
    <Group gap="sm" wrap="nowrap" align="flex-start" my={8}>
      <ThemeIcon
        size={26}
        radius="xl"
        color="grape"
        variant="filled"
        style={{ filter: 'drop-shadow(0 0 4px var(--mantine-color-grape-5))' }}
      >
        <IconBolt size={14} />
      </ThemeIcon>
      <div>
        <Text size="md" fw={700} style={{ textShadow: '0 0 6px var(--mantine-color-grape-5)' }}>
          {(((multiplier ?? 1) - 1) * 100).toFixed(0)}% Bonus Buzz on every purchase
        </Text>
        {buzzAmount > 0 && (
          <Text size="xs" c="dimmed">
            +{numberWithCommas(Math.round(buzzAmount * ((multiplier ?? 1) - 1)))} extra on this
            purchase
          </Text>
        )}
      </div>
    </Group>
  ) : null;

  if (remaining.length === 0) {
    return (
      <Stack gap="xs">
        {multiplierRow}
        {visible.map((b, i) => (
          <BenefitRow key={i} content={b.content!} />
        ))}
      </Stack>
    );
  }

  return (
    <Stack gap="xs">
      {multiplierRow}
      {visible.map((b, i) => (
        <BenefitRow key={i} content={b.content!} />
      ))}
      <Collapse in={expanded}>
        <Stack gap="xs">
          {remaining.map((b, i) => (
            <BenefitRow key={i} content={b.content!} />
          ))}
        </Stack>
      </Collapse>
      <UnstyledButton onClick={toggle} aria-expanded={expanded} aria-label="Show more benefits">
        <Group gap={4} justify="center">
          <Text size="xs" c="dimmed">
            {expanded ? 'Show less' : `+ ${remaining.length} more benefits`}
          </Text>
          <IconChevronDown
            size={14}
            className="text-dimmed"
            style={{
              transform: expanded ? 'rotate(180deg)' : undefined,
              transition: 'transform 200ms',
            }}
          />
        </Group>
      </UnstyledButton>
    </Stack>
  );
}
