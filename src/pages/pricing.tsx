import {
  Card,
  Container,
  Title,
  Text,
  Button,
  Stack,
  Center,
  Loader,
  Alert,
  ThemeIcon,
  Group,
  createStyles,
  Anchor,
} from '@mantine/core';
import { trpc } from '~/utils/trpc';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PlanCard, getPlanDetails } from '~/components/Subscriptions/PlanCard';
import {
  IconCalendarDue,
  IconExclamationMark,
  IconHeart,
  IconHeartHandshake,
  IconInfoCircle,
  IconInfoTriangle,
  IconInfoTriangleFilled,
  IconPhotoPlus,
} from '@tabler/icons-react';
import { DonateButton } from '~/components/Stripe/DonateButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { PlanBenefitList, benefitIconSize } from '~/components/Subscriptions/PlanBenefitList';
import { joinRedirectReasons, JoinRedirectReason } from '~/utils/join-helpers';
import { useRouter } from 'next/router';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { constants } from '~/server/common/constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  appliesForFounderDiscount,
  useActiveSubscription,
} from '~/components/Stripe/memberships.util';
import { formatDate } from '~/utils/date-helpers';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { Meta } from '~/components/Meta/Meta';
import { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { env } from '~/env/client.mjs';

export default function Pricing() {
  const router = useRouter();
  const { classes, cx } = useStyles();
  const { returnUrl = '/', reason } = router.query as {
    returnUrl: string;
    reason: JoinRedirectReason;
  };
  const features = useFeatureFlags();
  const redirectReason = joinRedirectReasons[reason];
  const paymentProvider = usePaymentProvider();

  const { data: products, isLoading: productsLoading } = trpc.subscriptions.getPlans.useQuery({});
  const { subscription, subscriptionLoading, subscriptionPaymentProvider, isFreeTier } =
    useActiveSubscription({
      checkWhenInBadState: true,
    });

  const isLoading = productsLoading || subscriptionLoading;
  const currentMembershipUnavailable =
    !!subscription &&
    !productsLoading &&
    !isFreeTier &&
    !(products ?? []).find((p) => p.id === subscription.product.id) &&
    // Ensures we have products from the current provider.
    (products ?? []).some((p) => p.provider === subscription.product.provider);

  const freePlanDetails = getPlanDetails(constants.freeMembershipDetails, features);
  const metadata = (subscription?.product?.metadata ?? {
    tier: 'free',
  }) as SubscriptionProductMetadata;
  const appliesForDiscount = features.membershipsV2 && appliesForFounderDiscount(metadata.tier);
  const activeSubscriptionIsNotDefaultProvider =
    subscription && subscriptionPaymentProvider !== paymentProvider;

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
          <Title align="center" className={classes.title}>
            Memberships
          </Title>
          <Text align="center" className={classes.introText} sx={{ lineHeight: 1.25 }}>
            As the leading generative AI community, we&rsquo;re adding new features every week. Help
            us keep the community thriving by becoming a Supporter and get exclusive perks.
          </Text>
          <Text align="center" className={classes.introText} sx={{ lineHeight: 1.25 }}>
            Your Membership provides full access across all Civitai domains, ensuring the same great
            benefits and features wherever you explore
          </Text>
        </Stack>
      </Container>
      <Container size="xl">
        <Stack>
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
                    <Anchor component="button" type="button">
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
            {currentMembershipUnavailable && (
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
            )}
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
                  <PlanCard product={product} subscription={subscription} />
                </ContainerGrid.Col>
              ))}
            </ContainerGrid>
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
    if (!features?.isGreen || !features?.canBuyBuzz)
      return {
        redirect: {
          destination: `https://${env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN}/pricing?sync-account=blue`,
          statusCode: 302,
          basePath: false,
        },
      };
  },
});
