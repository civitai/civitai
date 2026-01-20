import {
  Alert,
  Anchor,
  Box,
  Button,
  Card,
  Center,
  Container,
  Grid,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconInfoCircle,
  IconInfoTriangleFilled,
  IconRotateClockwise,
  IconExternalLink,
} from '@tabler/icons-react';
import { capitalize } from 'lodash-es';
import { useRouter } from 'next/router';
import * as z from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { BuzzEnvironmentAlert } from '~/components/Buzz/BuzzEnvironmentAlert';
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
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
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
import styles from './membership.module.scss';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session || !session.user)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };

    // Allow users with subscriptionId OR users in memberInBadState to access the page
    // Users in bad state need to be able to manage/cancel their subscription
    if (!session.user.subscriptionId && !session.user.memberInBadState)
      return {
        redirect: {
          destination: '/pricing',
          permanent: false,
        },
      };
  },
});

const querySchema = z.object({
  tier: userTierSchema.optional(),
  updated: booleanString().optional(),
  downgraded: booleanString().optional(),
});

export default function UserMembership() {
  const [activeBuzzType] = useAvailableBuzz();
  const { subscription, subscriptionLoading, subscriptionPaymentProvider } = useActiveSubscription({
    checkWhenInBadState: true,
    buzzType: activeBuzzType,
  });

  // Check for subscriptions in other buzz types
  const otherBuzzType = activeBuzzType === 'green' ? 'yellow' : 'green';
  const { subscription: otherSubscription, subscriptionLoading: otherSubscriptionLoading } =
    useActiveSubscription({
      checkWhenInBadState: true,
      buzzType: otherBuzzType,
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
  const { classNames: buzzClassNames, colorRgb: buzzColorRgb } =
    useBuzzCurrencyConfig(activeBuzzType);
  // const isCheckingPaddleSubscription = usePaddleSubscriptionRefresh();
  const isCheckingPaddleSubscription = false; // No refreshing for now since Paddle is dead
  const query = querySchema.safeParse(router.query);
  const isDrowngrade = query.success ? query.data?.downgraded : false;
  const downgradedTier = query.success ? isDrowngrade && query.data?.tier : null;
  const isUpdate = query.success ? query.data?.updated : false;
  const { refreshSubscription, refreshingSubscription } = useMutatePaddle();

  const handleRedirectToOtherEnvironment = () => {
    const targetDomain =
      otherBuzzType === 'green'
        ? env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN
        : env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE;
    const syncParam = otherBuzzType === 'green' ? 'yellow' : 'green';

    window.open(
      `//${targetDomain}/user/membership?sync-account=${syncParam}`,
      '_blank',
      'noreferrer'
    );
  };

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

  if (subscriptionLoading || isCheckingPaddleSubscription || otherSubscriptionLoading) {
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
      <>
        <Meta title="My Membership" deIndex />
        <Container size="md">
          <Stack gap="xl">
            <Title>My Membership Plan</Title>

            {/* Show alert if user has subscription in other environment */}
            {otherSubscription && (
              <BuzzEnvironmentAlert
                buzzType={otherBuzzType}
                onViewMembership={handleRedirectToOtherEnvironment}
                message={`You have an active ${
                  otherBuzzType === 'green' ? 'Green' : 'Yellow'
                } membership`}
              />
            )}

            <Card padding="lg" radius="md" className={styles.noSubscriptionCard}>
              <Stack gap="md">
                <Group gap="md" wrap="nowrap">
                  <ThemeIcon size="lg" color="red" variant="light" radius="md">
                    <IconInfoTriangleFilled size={24} />
                  </ThemeIcon>
                  <div style={{ flex: 1 }}>
                    <Text size="lg" fw={700} c="red">
                      No active subscription
                    </Text>
                    <Text size="sm" c="dimmed">
                      We couldn&rsquo;t find an active{' '}
                      {activeBuzzType === 'green' ? 'Green' : 'Yellow'} membership
                    </Text>
                  </div>
                </Group>

                <Text size="sm">
                  If you believe this is a mistake, you may try refreshing your session in your
                  settings.
                </Text>
              </Stack>
            </Card>
          </Stack>
        </Container>
      </>
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
            <Stack gap="xl">
              <Title>My Membership Plan</Title>
              {otherSubscription && subscription && (
                <BuzzEnvironmentAlert
                  buzzType={otherBuzzType}
                  onViewMembership={handleRedirectToOtherEnvironment}
                  message={`You also have an active ${
                    otherBuzzType === 'green' ? 'Green' : 'Yellow'
                  } membership`}
                  buttonText={`View ${otherBuzzType === 'green' ? 'Green' : 'Yellow'} Membership`}
                />
              )}
              {/*
              {subscriptionPaymentProvider !== paymentProvider && !isCivitaiProvider && (
                <Alert>
                  We are currently migrating your account info to our new payment processor, until
                  this is completed you will be unable to upgrade your subscription. Migration is
                  taking a bit longer than expected, but we are working hard to get it done as soon
                  as possible.
                </Alert>
              )} */}
              {isDrowngrade && downgradedTier && (
                <Alert>
                  You have successfully downgraded your membership to the{' '}
                  {capitalize(downgradedTier)} tier. It may take a few seconds for your new plan to
                  take effect. You may refresh the page to see the changes.
                </Alert>
              )}

              <>
                {subscriptionPaymentProvider !== paymentProvider &&
                  subscriptionPaymentProvider !== PaymentProvider.Civitai && (
                    <Alert>
                      We are currently migrating your account info to our new payment processor,
                      until this is completed you will be unable to upgrade your subscription.
                      Migration is taking a bit longer than expected, but we are working hard to get
                      it done as soon as possible.
                    </Alert>
                  )}
                {isDrowngrade && downgradedTier && (
                  <Alert>
                    You have successfully downgraded your membership to the{' '}
                    {capitalize(downgradedTier)} tier. It may take a few seconds for your new plan
                    to take effect. You may refresh the page to see the changes.
                  </Alert>
                )}
                {isUpdate && (
                  <Alert>
                    Your membership has been successfully updated. It may take a few minutes for
                    your update to take effect. If you don&rsquo;t see the changes after refreshing
                    the page in a few minutes, please contact support. Please note: Your membership
                    bonus Buzz may take up to 1 hour to be delivered.
                  </Alert>
                )}
              </>

              {subscription?.isBadState && (
                <AlertWithIcon
                  color="red"
                  iconColor="red"
                  icon={<IconInfoTriangleFilled size={20} strokeWidth={2.5} />}
                  iconSize="lg"
                  py={11}
                >
                  <Stack gap="xs">
                    <Text lh={1.2} fw={600}>
                      Payment failed - your membership is on hold
                    </Text>
                    <Text lh={1.2} size="sm">
                      Your recent payment didn&apos;t go through. Your membership benefits are
                      currently paused until this is resolved.
                    </Text>
                    <Group gap="xs" mt={4}>
                      {isStripe ? (
                        <SubscribeButton
                          priceId={subscription.price.id}
                          disabled={features.disablePayments}
                        >
                          <Button size="xs" color="red">
                            Update Payment Method
                          </Button>
                        </SubscribeButton>
                      ) : (
                        <Button
                          size="xs"
                          color="red"
                          component="a"
                          href={managementUrls?.updatePaymentMethod as string}
                          target="_blank"
                        >
                          Update Payment Method
                        </Button>
                      )}
                      <CancelMembershipAction
                        variant="button"
                        buttonProps={{ size: 'xs', color: 'gray', variant: 'outline' }}
                      />
                    </Group>
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
                        {canUpgrade && !subscription.isBadState && (
                          <Button component={Link} href="/pricing" radius="xl">
                            Upgrade
                          </Button>
                        )}
                        {!subscription.cancelAt && !isCivitaiProvider && !subscription.isBadState && (
                          <CancelMembershipAction
                            variant="button"
                            buttonProps={{ radius: 'xl', color: 'red', variant: 'outline' }}
                          />
                        )}
                        {subscription.isBadState && isStripe && (
                          <SubscribeButton
                            priceId={subscription.price.id}
                            disabled={features.disablePayments}
                          >
                            <Button radius="xl" color="red">
                              Update Payment
                            </Button>
                          </SubscribeButton>
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
                <div
                  style={{
                    // @ts-ignore
                    '--buzz-color': buzzColorRgb,
                  }}
                >
                  <Title order={3}>
                    Your{' '}
                    <Text component="span" className="text-xl font-bold text-buzz">
                      {activeBuzzType === 'green' ? 'Green' : 'Yellow'}
                    </Text>{' '}
                    membership benefits
                  </Title>
                  <Paper withBorder className={styles.card}>
                    <PlanBenefitList
                      benefits={benefits}
                      buzzType={subscription.buzzType}
                      tier={subscription.product.metadata.tier}
                    />
                  </Paper>
                </div>
              )}
            </Stack>
          </Grid.Col>
        </Grid>
      </Container>
    </>
  );
}
