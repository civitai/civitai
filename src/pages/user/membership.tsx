import {
  Alert,
  Anchor,
  Box,
  Button,
  Center,
  Container,
  Grid,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconInfoCircle, IconInfoTriangleFilled, IconRotateClockwise } from '@tabler/icons-react';
import { capitalize } from 'lodash-es';
import { useRouter } from 'next/router';
import * as z from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useMutatePaddle, useSubscriptionManagementUrls } from '~/components/Paddle/util';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useActiveSubscription, useCanUpgrade } from '~/components/Stripe/memberships.util';
import { shortenPlanInterval } from '~/components/Stripe/stripe.utils';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { CancelMembershipAction } from '~/components/Subscriptions/CancelMembershipAction';
import { PlanBenefitList } from '~/components/Subscriptions/PlanBenefitList';
import { PrepaidTimelineProgress } from '~/components/Subscriptions/PrepaidTimelineProgress';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { userTierSchema } from '~/server/schema/user.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { getStripeCurrencyDisplay } from '~/utils/string-helpers';
import { booleanString } from '~/utils/zod-helpers';
import styles from './membership.module.css';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx, features }) => {
    if (!session || !session.user)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };

    if (!session.user.subscriptionId)
      return {
        redirect: {
          destination: '/pricing',
          permanent: false,
        },
      };

    if (!features?.canBuyBuzz && env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN) {
      return {
        redirect: {
          destination: `https://${env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN}/user/membership?sync-account=blue`,
          statusCode: 302,
          basePath: false,
        },
      };
    }
  },
});

const querySchema = z.object({
  tier: userTierSchema.optional(),
  updated: booleanString().optional(),
  downgraded: booleanString().optional(),
});

export default function UserMembership() {
  const { subscription, subscriptionLoading, subscriptionPaymentProvider } = useActiveSubscription({
    checkWhenInBadState: true,
  });

  const isPaddle = subscriptionPaymentProvider === PaymentProvider.Paddle;
  const isStripe = subscriptionPaymentProvider === PaymentProvider.Stripe;

  const { managementUrls } = useSubscriptionManagementUrls({
    enabled: isPaddle,
  });

  const currentUser = useCurrentUser();
  const paymentProvider = usePaymentProvider();
  const features = useFeatureFlags();
  const canUpgrade = useCanUpgrade();
  const router = useRouter();
  // const isCheckingPaddleSubscription = usePaddleSubscriptionRefresh();
  const isCheckingPaddleSubscription = false; // No refreshing for now since Paddle is dead
  const query = querySchema.safeParse(router.query);
  const isDrowngrade = query.success ? query.data?.downgraded : false;
  const downgradedTier = query.success ? isDrowngrade && query.data?.tier : null;
  const isUpdate = query.success ? query.data?.updated : false;
  const { refreshSubscription, refreshingSubscription } = useMutatePaddle();

  const handleRefreshSubscription = async () => {
    try {
      await refreshSubscription();
      showSuccessNotification({
        title: 'Subscription refreshed',
        message: 'Your subscription has been successfully refreshed',
      });
    } catch (error: unknown) {
      console.error('Failed to refresh subscription', error);
      showErrorNotification({
        title: 'Whoops!',
        error:
          error instanceof Error
            ? error
            : { message: 'An error occurred while refreshing your subscription' },
        reason:
          error instanceof Error
            ? error.message
            : 'An error occurred while refreshing your subscription',
      });
    }
  };

  if (subscriptionLoading || isCheckingPaddleSubscription) {
    return (
      <Container size="lg">
        <Center>
          <Loader />
        </Center>
      </Container>
    );
  }

  if (!subscription) {
    return (
      <Container size="md">
        <Alert color="red" title="No active subscription">
          <Stack>
            <Text>
              We could not find an active subscription for your account. If you believe this is a
              mistake, you may try refreshing your session on your settings.
            </Text>

            {currentUser?.paddleCustomerId && (
              <>
                <Text>
                  If you have signed up for a subscription with our new Paddle payment processor,
                  click the button below to sync your account.
                </Text>

                <Button
                  color="yellow"
                  loading={refreshingSubscription}
                  onClick={handleRefreshSubscription}
                >
                  Refresh now
                </Button>
              </>
            )}
          </Stack>
        </Alert>
      </Container>
    );
  }

  const price = subscription.price;
  const product = subscription.product;
  const meta = product?.metadata as SubscriptionProductMetadata;
  const isFree = meta?.tier === 'free';
  const { image, benefits } = getPlanDetails(subscription.product, features);
  const isCivitaiProvider = subscriptionPaymentProvider === PaymentProvider.Civitai;

  return (
    <>
      <Meta title="My Membership" deIndex />
      <Container size="md">
        <Grid>
          <Grid.Col span={12}>
            <Stack>
              <Title>My Membership Plan</Title>
              {subscriptionPaymentProvider !== paymentProvider && !isCivitaiProvider && (
                <Alert>
                  We are currently migrating your account info to our new payment processor, until
                  this is completed you will be unable to upgrade your subscription. Migration is
                  taking a bit longer than expected, but we are working hard to get it done as soon
                  as possible.
                </Alert>
              )}
              {isDrowngrade && downgradedTier && (
                <Alert>
                  You have successfully downgraded your membership to the{' '}
                  {capitalize(downgradedTier)} tier. It may take a few seconds for your new plan to
                  take effect. You may refresh the page to see the changes.
                </Alert>
              )}
              {isUpdate && (
                <Alert>
                  Your membership has been successfully updated. It may take a few minutes for your
                  update to take effect. If you don&rsquo;t see the changes after refreshing the
                  page in a few minutes, please contact support. Please note: Your membership bonus
                  Buzz may take up to 1 hour to be delivered.
                </Alert>
              )}
              {subscription?.isBadState && (
                <AlertWithIcon
                  color="red"
                  iconColor="red"
                  icon={<IconInfoTriangleFilled size={20} strokeWidth={2.5} />}
                  iconSize="lg"
                  py={11}
                >
                  <Stack gap={0}>
                    <Text lh={1.2}>
                      Uh oh! It looks like there was an issue with your membership. You can update
                      your payment method or renew your membership now by clicking{' '}
                      {isStripe ? (
                        <SubscribeButton
                          priceId={subscription.price.id}
                          disabled={features.disablePayments}
                        >
                          <Anchor component="button" type="button">
                            here
                          </Anchor>
                        </SubscribeButton>
                      ) : (
                        <Anchor
                          href={managementUrls?.updatePaymentMethod as string}
                          target="_blank"
                        >
                          here
                        </Anchor>
                      )}
                      .
                    </Text>
                  </Stack>
                </AlertWithIcon>
              )}
              <Paper withBorder className={styles.card}>
                <Stack>
                  <Group justify="space-between">
                    <Group wrap="nowrap">
                      {image && (
                        <Center>
                          <Box w={100}>
                            <EdgeMedia src={image} />
                          </Box>
                        </Center>
                      )}
                      <Stack gap={0}>
                        {product && (
                          <Text fw={600} size="20px">
                            {isFree ? 'Free' : product.name}
                          </Text>
                        )}
                        {price && (
                          <Text>
                            <Text component="span" className={styles.price}>
                              {getStripeCurrencyDisplay(price.unitAmount, price.currency)}
                            </Text>{' '}
                            <Text component="span" c="dimmed" size="sm">
                              {price.currency.toUpperCase() +
                                '/' +
                                shortenPlanInterval(price.interval)}
                            </Text>
                          </Text>
                        )}
                      </Stack>
                    </Group>
                    <Stack className="@sm:items-end">
                      <Group gap="xs">
                        {subscription.canceledAt && (
                          <>
                            {price.active && (
                              <SubscribeButton
                                priceId={price.id}
                                disabled={features.disablePayments}
                              >
                                <Button
                                  radius="xl"
                                  rightSection={<IconRotateClockwise size={16} />}
                                >
                                  Resume
                                </Button>
                              </SubscribeButton>
                            )}
                            {!price.active && (
                              <Tooltip
                                maw={350}
                                multiline
                                label="Your old subscription price has been discontinued and cannot be restored. If you'd like to keep supporting us, consider upgrading"
                              >
                                <LegacyActionIcon variant="light" color="dark" size="lg">
                                  <IconInfoCircle color="white" strokeWidth={2.5} size={26} />
                                </LegacyActionIcon>
                              </Tooltip>
                            )}
                          </>
                        )}
                        {canUpgrade && (
                          <Button component={Link} href="/pricing" radius="xl">
                            Upgrade
                          </Button>
                        )}
                        {!subscription.cancelAt && !isCivitaiProvider && (
                          <CancelMembershipAction
                            variant="button"
                            buttonProps={{ radius: 'xl', color: 'red', variant: 'outline' }}
                          />
                        )}
                      </Group>
                      {!subscription.cancelAt &&
                        isPaddle &&
                        managementUrls?.updatePaymentMethod && (
                          <Anchor
                            href={managementUrls?.updatePaymentMethod as string}
                            target="_blank"
                            size="xs"
                          >
                            Update payment details
                          </Anchor>
                        )}
                    </Stack>
                  </Group>
                  {subscription.cancelAt && (
                    <Text c="red">
                      Your membership will be canceled on{' '}
                      {new Date(subscription.cancelAt).toLocaleDateString()}. You will lose your
                      benefits on that date.
                    </Text>
                  )}
                  {isCivitaiProvider && (
                    <Text c="yellow">
                      You are currently in a pre-paid membership. No subsequent charges will be made
                      to your account.
                    </Text>
                  )}
                </Stack>
              </Paper>

              <PrepaidTimelineProgress subscription={subscription} />

              {benefits && (
                <>
                  <Title order={3}>Your membership benefits</Title>
                  <Paper withBorder className={styles.card}>
                    <PlanBenefitList benefits={benefits} />
                  </Paper>
                </>
              )}
            </Stack>
          </Grid.Col>
        </Grid>
      </Container>
    </>
  );
}
