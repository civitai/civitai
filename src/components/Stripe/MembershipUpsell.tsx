import {
  Text,
  Stack,
  Group,
  Button,
  Anchor,
  Badge,
  Loader,
  Center,
  Card,
  Title,
  ThemeIcon,
  Box,
} from '@mantine/core';
import { IconBolt, IconCheck, IconDiamond, IconStar } from '@tabler/icons-react';
import { capitalize } from 'lodash-es';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import {
  getEligibleUpgradePlans,
  pickClosestPlanByPrice,
  useActiveSubscription,
} from '~/components/Stripe/memberships.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { formatPriceForDisplay } from '~/utils/number-helpers';
import { formatRewardsBoost } from '~/utils/buzz';
import { trpc } from '~/utils/trpc';
import { MembershipUpgradeModal } from '~/components/Stripe/MembershipChangePrevention';
import { dialogStore } from '~/components/Dialog/dialogStore';
import classes from './MembershipUpsell.module.scss';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';

export const MembershipUpsell = ({
  buzzAmount,
  selectedUnitAmount,
  onClick,
}: {
  buzzAmount: number;
  selectedUnitAmount?: number;
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

  const eligiblePlans = getEligibleUpgradePlans(products, subscription);

  const targetPlan = selectedUnitAmount
    ? pickClosestPlanByPrice(eligiblePlans, selectedUnitAmount)
    : eligiblePlans.find((product, index) => {
        const metadata = (product?.metadata ?? {
          monthlyBuzz: 0,
          tier: 'free',
        }) as SubscriptionProductMetadata;
        return (metadata.monthlyBuzz ?? 0) >= buzzAmount || index === eligiblePlans.length - 1;
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
        <Badge variant="light" size="md" color="grape" className={classes.badge}>
          <Group gap={4}>
            <IconStar size={16} fill="currentColor" />
            <Text tt="uppercase" fw={600} size="xs">
              Pro
            </Text>
          </Group>
        </Badge>

        {image && (
          <Box className={classes.imageFloat}>
            <EdgeMedia src={image} width={80} />
          </Box>
        )}

        {/* Title and icon */}
        <Group gap="sm" align="center">
          <ThemeIcon size={32} radius="lg" className={classes.tierIcon}>
            <IconDiamond size={18} />
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
          rewardsMultiplier={
            (metadata.rewardsMultiplier ?? 1) > 1 ? metadata.rewardsMultiplier! : undefined
          }
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

function BenefitRow({ content }: { content: React.ReactNode }) {
  return (
    <Group gap="sm" wrap="nowrap" align="center">
      <ThemeIcon size={22} radius="xl" color="grape" variant="light" className="shrink-0">
        <IconCheck size={12} />
      </ThemeIcon>
      <Text className={classes.benefitText} size="sm" component="div">
        {content}
      </Text>
    </Group>
  );
}

function BenefitsList({
  benefits,
  rewardsMultiplier,
}: {
  benefits: { content?: React.ReactNode; key?: string }[];
  rewardsMultiplier?: number;
}) {
  const filtered = benefits.filter((b) => b.content && b.key !== 'rewardsMultiplier');

  return (
    <Stack gap="xs">
      {rewardsMultiplier && (
        <Group gap="sm" wrap="nowrap" align="flex-start" my={4}>
          <ThemeIcon size={26} radius="xl" color="blue" variant="light" className="shrink-0">
            <IconBolt size={16} />
          </ThemeIcon>
          <div>
            <Text size="md" className={classes.multiplierText}>
              {formatRewardsBoost(rewardsMultiplier)} Blue Buzz from rewards
            </Text>
          </div>
        </Group>
      )}
      {filtered.map((b, i) => (
        <BenefitRow key={i} content={b.content!} />
      ))}
    </Stack>
  );
}
