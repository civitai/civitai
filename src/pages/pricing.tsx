import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Container,
  createStyles,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconExclamationMark, IconInfoCircle, IconInfoTriangleFilled } from '@tabler/icons-react';
import Image from 'next/image';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { usePaddleSubscriptionRefresh } from '~/components/Paddle/util';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import {
  appliesForFounderDiscount,
  useActiveSubscription,
} from '~/components/Stripe/memberships.util';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { PlanBenefitList } from '~/components/Subscriptions/PlanBenefitList';
import { PlanCard } from '~/components/Subscriptions/PlanCard';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { env } from '~/env/client';
import { isDev } from '~/env/other';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate, isHolidaysTime } from '~/utils/date-helpers';
import type { JoinRedirectReason } from '~/utils/join-helpers';
import { joinRedirectReasons } from '~/utils/join-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { trpc } from '~/utils/trpc';
import { useLiveFeatureFlags } from '~/hooks/useLiveFeatureFlags';

export default function Pricing() {
  const router = useRouter();
  const { classes, cx } = useStyles();
  const { returnUrl = '/', reason } = router.query as {
    returnUrl: string;
    reason: JoinRedirectReason;
  };
  const features = useFeatureFlags();
  const liveFeatures = useLiveFeatureFlags();
  const redirectReason = joinRedirectReasons[reason];
  const paymentProvider = usePaymentProvider();

  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const { subscription, subscriptionLoading, subscriptionPaymentProvider, isFreeTier } =
    useActiveSubscription({
      checkWhenInBadState: true,
    });
  const { data: products, isLoading: productsLoading } = trpc.subscriptions.getPlans.useQuery({
    interval,
  });

  const isLoading = productsLoading;

  const currentMembershipUnavailable =
    (subscription && !subscription?.product?.active) ||
    (!!subscription &&
      !productsLoading &&
      !isFreeTier &&
      !(products ?? []).find((p) => p.id === subscription.product.id) &&
      // Ensures we have products from the current provider.
      !(products ?? []).some((p) => p.provider === subscription.product.provider));

  const freePlanDetails = getPlanDetails(constants.freeMembershipDetails, features);
  const metadata = (subscription?.product?.metadata ?? {
    tier: 'free',
  }) as SubscriptionProductMetadata;
  const appliesForDiscount = features.membershipsV2 && appliesForFounderDiscount(metadata.tier);
  const activeSubscriptionIsNotDefaultProvider =
    subscription && subscriptionPaymentProvider !== paymentProvider;

  const isHolidays = isHolidaysTime();

  useEffect(() => {
    setInterval(subscription?.price?.interval ?? 'month');
  }, [subscription?.price?.interval]);

  return (
    <>
      <Meta
        title="Memberships | Civitai"
        description="As the leading generative AI community, we're adding new features every week. Help us keep the community thriving by becoming a Supporter and get exclusive perks."
      />
      <Container size="sm" mb="lg">
        <Stack>
          {!!redirectReason && (
            <Alert color="yellow">
              <Group spacing="xs" noWrap align="flex-start">
                <ThemeIcon color="yellow">
                  <IconExclamationMark />
                </ThemeIcon>
                <Text size="md">{redirectReason}</Text>
              </Group>
            </Alert>
          )}
          {isHolidays && !redirectReason && (
            <Alert color="blue">
              <div className="flex flex-col items-center gap-4 md:flex-row">
                <Image
                  src="/images/holiday/happy-holidays-robot.png"
                  alt="happy-holidays"
                  width={150}
                  height={150}
                  className="hidden rounded-md md:block"
                />

                <Stack spacing="xs">
                  <Text size="md">
                    To celebrate the holidays and our amazing community, new subscribers and current
                    members alike will receive 20% additional Blue Buzz along with their standard
                    Buzz disbursement!
                  </Text>
                  <Text size="md">
                    This bonus applies when a new membership is purchased or an active membership
                    renews.
                  </Text>
                  <Text size="md">Happy Holidays from Civitai!</Text>
                </Stack>
              </div>
            </Alert>
          )}

          <Title align="center" className={classes.title}>
            Memberships
          </Title>
          <Text align="center" className={classes.introText} sx={{ lineHeight: 1.25 }}>
            As the leading generative AI community, we&rsquo;re adding new features every week. Help
            us keep the community thriving by becoming a Supporter and get exclusive perks.
          </Text>
        </Stack>
      </Container>
      <Container size="xl">
        <Stack>
          {features.disablePayments && (
            <Center>
              <AlertWithIcon
                color="red"
                iconColor="red"
                icon={<IconInfoTriangleFilled size={20} strokeWidth={2.5} />}
                iconSize={28}
                py={11}
                maw="calc(50% - 8px)"
              >
                <Stack spacing={0}>
                  <Text lh={1.2}>
                    Purchasing or updating memberships is currently disabled. We are working hard to
                    resolve this and will notify you when it is back up. You can still manage your
                    active membership, and your benefits will be active until your
                    membership&rsquo;s expiration date.{' '}
                    <Anchor href="https://civitai.com/articles/14945" color="red.3">
                      Learn more
                    </Anchor>
                  </Text>
                </Stack>
              </AlertWithIcon>
            </Center>
          )}
          {(features.nowpaymentPayments ||
            features.coinbasePayments ||
            liveFeatures.buzzGiftCards) &&
            features.disablePayments && (
              <Center>
                <AlertWithIcon
                  color="yellow"
                  iconColor="yellow"
                  icon={<IconInfoCircle size={20} strokeWidth={2.5} />}
                  iconSize={28}
                  py={11}
                  maw="calc(50% - 8px)"
                >
                  <Stack spacing={0}>
                    <Text lh={1.2}>You can still purchase Buzz: </Text>
                    <Group>
                      {(features.nowpaymentPayments || features.coinbasePayments) && (
                        <Anchor href="/purchase/buzz" color="yellow.7">
                          Buy with Crypto
                        </Anchor>
                      )}
                      {liveFeatures.buzzGiftCards && (
                        <Anchor
                          href="https://buybuzz.io/"
                          target="_blank"
                          rel="noopener noreferrer"
                          color="yellow.7"
                        >
                          Buy a Gift Card
                        </Anchor>
                      )}
                    </Group>
                  </Stack>
                </AlertWithIcon>
              </Center>
            )}
          {subscription?.isBadState && (
            <AlertWithIcon
              color="red"
              iconColor="red"
              icon={<IconInfoTriangleFilled size={20} strokeWidth={2.5} />}
              iconSize={28}
              py={11}
            >
              <Stack spacing={0}>
                <Text lh={1.2}>
                  Uh oh! It looks like there was an issue with your membership. You can update your
                  payment method or renew your membership now by clicking{' '}
                  <SubscribeButton priceId={subscription.price.id}>
                    <Anchor component="button" type="button" disabled={features.disablePayments}>
                      here
                    </Anchor>
                  </SubscribeButton>
                </Text>
                <Text lh={1.2}>
                  Alternatively, click <Anchor href="/user/membership">here</Anchor> to view all
                  your benefits
                </Text>
              </Stack>
            </AlertWithIcon>
          )}
          {activeSubscriptionIsNotDefaultProvider && (
            <AlertWithIcon
              color="red"
              iconColor="red"
              icon={<IconInfoTriangleFilled size={20} strokeWidth={2.5} />}
              iconSize={28}
              py={11}
            >
              <Stack spacing={0}>
                <Text lh={1.2}>
                  Uh oh! Your active subscription is not using our default payment provider. We are
                  working on this issue and will notify you when it is resolved.
                </Text>
                <Text lh={1.2}>
                  You are still able to view and manage your subscription. You may be prompted to
                  enter additional information to ensure your subscription renews.
                </Text>

                <Text lh={1.2}>
                  You can still manage your subscription clicking{' '}
                  <Anchor href="/user/membership">here</Anchor> to view your current benefits.
                </Text>
              </Stack>
            </AlertWithIcon>
          )}
          <Group>
            {/* {currentMembershipUnavailable && (
              <AlertWithIcon
                color="yellow"
                iconColor="yellow"
                icon={<IconInfoCircle size={20} strokeWidth={2.5} />}
                iconSize={28}
                py={11}
                maw="calc(50% - 8px)"
                mx="auto"
              >
                <Text lh={1.2}>
                  The Supporter plan can no longer be purchased. You can stay on your{' '}
                  <Text component={Link} td="underline" href="/user/membership">
                    current plan
                  </Text>{' '}
                  or level up your support here.
                </Text>
              </AlertWithIcon>
            )} */}
            {appliesForDiscount && (
              <Alert maw={650} mx="auto" py={4} miw="calc(50% - 8px)" pl="sm">
                <Group spacing="xs">
                  <EdgeMedia src="df2b3298-7352-40d6-9fbc-17a08e2a43c5" width={48} />
                  <Stack spacing={0}>
                    <Text color="blue" weight="bold">
                      Supporter Offer!
                    </Text>
                    <Text>
                      Get {constants.memberships.founderDiscount.discountPercent}% off your first
                      month and get a special badge! Offer ends{' '}
                      {formatDate(constants.memberships.founderDiscount.maxDiscountDate)}.
                    </Text>
                  </Stack>
                </Group>
              </Alert>
            )}
          </Group>
          {(features.annualMemberships || interval === 'year') && (
            <Center>
              <SegmentedControl
                radius="md"
                value={interval}
                onChange={(value) => setInterval(value as 'month' | 'year')}
                size="md"
                data={[
                  { value: 'month', label: 'Monthly Plans' },
                  {
                    value: 'year',
                    label: (
                      <Center>
                        <Box mr={6}>Annual Plans</Box>
                        <Badge p={5} color="green" variant="filled" radius="xl">
                          1 month for free!
                        </Badge>
                      </Center>
                    ),
                  },
                ]}
              />
            </Center>
          )}

          {subscription?.price?.interval === 'year' && interval === 'month' && (
            <AlertWithIcon
              color="yellow"
              iconColor="yellow"
              icon={<IconInfoCircle size={20} strokeWidth={2.5} />}
              iconSize={28}
              py={11}
              maw="calc(50% - 8px)"
              mx="auto"
            >
              <Group spacing="xs" noWrap align="flex-start">
                <Text size="md">
                  You&rsquo;re currently on an annual plan. You can upgrade to a different annual
                  plan or cancel your current one at any time. However, switching to a monthly plan
                  requires canceling your membership first and waiting for it to expire before
                  signing up again.
                </Text>
              </Group>
            </AlertWithIcon>
          )}
          {isLoading ? (
            <Center p="xl">
              <Loader />
            </Center>
          ) : !products ? (
            <Center>
              <Alert p="xl" title="There are no products to display">
                Check back in a little while to see what we have to offer
              </Alert>
            </Center>
          ) : (
            <ContainerGrid justify="center">
              <ContainerGrid.Col md={3} sm={6} xs={12}>
                <Card className={classes.card}>
                  <Stack style={{ height: '100%' }}>
                    <Stack spacing="md" mb="md">
                      <Title className={classes.cardTitle} order={2} align="center" mb="sm">
                        Free
                      </Title>
                      <Center style={{ opacity: 0.3 }}>
                        <EdgeMedia
                          src={freePlanDetails.image}
                          width={128}
                          className={classes.image}
                        />
                      </Center>
                      <Group position="center" spacing={4} align="flex-end" mb={24}>
                        <Text
                          className={classes.price}
                          align="center"
                          lh={1}
                          mt={appliesForDiscount ? 'md' : undefined}
                        >
                          $0
                        </Text>
                      </Group>
                      {!isFreeTier ? (
                        <Button radius="xl" color="gray" component={Link} href="/user/membership">
                          Downgrade to free
                        </Button>
                      ) : (
                        <Button radius="xl" disabled color="gray">
                          Current
                        </Button>
                      )}
                    </Stack>
                    <PlanBenefitList benefits={freePlanDetails.benefits} defaultBenefitsDisabled />
                  </Stack>
                </Card>
              </ContainerGrid.Col>
              {products.map((product) => (
                <ContainerGrid.Col key={product.id} md={3} sm={6} xs={12}>
                  <PlanCard
                    key={`${interval}-${product.id}`}
                    product={product}
                    subscription={subscription}
                  />
                </ContainerGrid.Col>
              ))}
            </ContainerGrid>
          )}

          {!isLoading && (
            <Stack spacing={0}>
              <p className="mb-0 text-xs opacity-50">
                By purchasing a membership, you agree to our{' '}
                <Anchor href="/content/tos">Terms of Service</Anchor>
              </p>
              <p className="text-xs opacity-50">
                Transactions will appear as CIVIT AI INC on your billing statement
              </p>
            </Stack>
          )}
        </Stack>
      </Container>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  title: {
    [containerQuery.smallerThan('sm')]: {
      fontSize: 24,
    },
  },
  introText: {
    [containerQuery.smallerThan('sm')]: {
      fontSize: 14,
    },
  },
  image: {
    [containerQuery.smallerThan('sm')]: {
      width: 96,
      marginBottom: theme.spacing.xs,
    },
  },
  cardTitle: {
    [containerQuery.smallerThan('sm')]: {
      fontSize: 20,
    },
  },
  card: {
    height: '100%',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
  },
  price: {
    fontSize: 48,
    fontWeight: 'bold',
  },
}));

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, features }) => {
    await ssg?.subscriptions.getPlans.prefetch({});
    await ssg?.subscriptions.getUserSubscription.prefetch();
    if (!isDev && !features?.canBuyBuzz)
      return {
        redirect: {
          destination: `https://${env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN}/pricing?sync-account=blue`,
          statusCode: 302,
          basePath: false,
        },
      };
  },
});
