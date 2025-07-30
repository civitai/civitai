import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Container,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconExclamationMark, IconInfoCircle, IconInfoTriangleFilled } from '@tabler/icons-react';
import clsx from 'clsx';
import Image from 'next/image';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { PlanBenefitList } from '~/components/Subscriptions/PlanBenefitList';
import { PlanCard } from '~/components/Subscriptions/PlanCard';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useLiveFeatureFlags } from '~/hooks/useLiveFeatureFlags';
import { constants } from '~/server/common/constants';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { isHolidaysTime } from '~/utils/date-helpers';
import type { JoinRedirectReason } from '~/utils/join-helpers';
import { joinRedirectReasons } from '~/utils/join-helpers';
import { trpc } from '~/utils/trpc';
import classes from '~/pages/pricing/index.module.scss';
import type { useActiveSubscription } from '~/components/Stripe/memberships.util';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { PaymentProvider } from '~/shared/utils/prisma/enums';

interface MembershipPlansProps {
  reason?: JoinRedirectReason;
  selectedBuzzType?: BuzzSpendType;
  onChangeBuzzType?: () => void;
  interval: 'month' | 'year';
  onIntervalChange: (interval: 'month' | 'year') => void;
  subscription: ReturnType<typeof useActiveSubscription>['subscription'];
  subscriptionPaymentProvider: ReturnType<
    typeof useActiveSubscription
  >['subscriptionPaymentProvider'];
  isFreeTier: ReturnType<typeof useActiveSubscription>['isFreeTier'];
  paymentProvider: string;
}

export function GreenMembershipPlans({
  reason,
  selectedBuzzType,
  onChangeBuzzType,
  interval,
  onIntervalChange,
  subscription,
  subscriptionPaymentProvider,
  isFreeTier,
  paymentProvider,
}: MembershipPlansProps) {
  const features = useFeatureFlags();
  const redirectReason = reason ? joinRedirectReasons[reason] : undefined;

  const { data: products, isLoading: productsLoading } = trpc.subscriptions.getPlans.useQuery({
    interval,
  });

  const isLoading = productsLoading;

  const currentMembershipUnavailable =
    !features.disablePayments &&
    ((subscription && !subscription?.product?.active) ||
      (!!subscription &&
        !productsLoading &&
        !isFreeTier &&
        !(products ?? []).find((p) => p.id === subscription.product.id) &&
        // Ensures we have products from the current provider.
        !(products ?? []).some((p) => p.provider === subscription.product.provider)));

  const freePlanDetails = getPlanDetails(constants.freeMembershipDetails, features);
  const activeSubscriptionIsNotDefaultProvider =
    !features.disablePayments && subscription && subscriptionPaymentProvider !== paymentProvider;
  const isHolidays = isHolidaysTime();
  const isCivitaiProvider = subscription && subscriptionPaymentProvider === PaymentProvider.Civitai;

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
              <Group gap="xs" wrap="nowrap" align="flex-start">
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

                <Stack gap="xs">
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
          <Title className={clsx(classes.title, 'text-center')}>Green Memberships</Title>
          <Text align="center" className={classes.introText} style={{ lineHeight: 1.25 }}>
            As the leading generative AI community, we&rsquo;re adding new features every week. Help
            us keep the community thriving by becoming a Supporter and get exclusive perks.
          </Text>
          {!features.isGreen && selectedBuzzType === 'green' && onChangeBuzzType && (
            <Center>
              <Button variant="subtle" size="sm" onClick={onChangeBuzzType}>
                Change Buzz Type
              </Button>
            </Center>
          )}
        </Stack>
      </Container>
      <Container size="xl">
        <Stack>
          {features.disablePayments && !features.prepaidMemberships && (
            <Center>
              <AlertWithIcon
                color="red"
                iconColor="red"
                icon={<IconInfoTriangleFilled size={20} strokeWidth={2.5} />}
                iconSize={28}
                py={11}
                maw="calc(50% - 8px)"
              >
                <Stack gap={0}>
                  <Text size="xs" lh={1.2}>
                    Purchasing or updating memberships is currently disabled. We are working hard to
                    resolve this and will notify you when it is back up. You can still manage your
                    active membership, and your benefits will be active until your
                    membership&rsquo;s expiration date.{' '}
                    <Anchor href="https://civitai.com/articles/14945" c="red.3">
                      Learn more
                    </Anchor>
                  </Text>
                </Stack>
              </AlertWithIcon>
            </Center>
          )}
          {features.disablePayments && features.prepaidMemberships && (
            <Center>
              <AlertWithIcon
                color="blue"
                iconColor="blue"
                icon={<IconInfoCircle size={20} strokeWidth={2.5} />}
                iconSize={28}
                py={11}
                maw="calc(50% - 8px)"
              >
                <Stack gap={0}>
                  <Text size="xs" lh={1.2}>
                    Regular membership purchases are temporarily disabled, but you can still
                    purchase prepaid memberships! Prepaid memberships give you all the same benefits
                    and will automatically activate when your current membership expires.{' '}
                    <Anchor
                      target="_blank"
                      href="https://buybuzz.io/collections/memberships"
                      rel="noopener noreferrer"
                      c="blue.3"
                    >
                      Purchase prepaid membership
                    </Anchor>
                  </Text>
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
              <Stack gap={0}>
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
          {activeSubscriptionIsNotDefaultProvider && !isCivitaiProvider && (
            <AlertWithIcon
              color="red"
              iconColor="red"
              icon={<IconInfoTriangleFilled size={20} strokeWidth={2.5} />}
              iconSize={28}
              py={11}
            >
              <Stack gap={0}>
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
          </Group>
          {(features.annualMemberships || interval === 'year') && (
            <Center>
              <SegmentedControl
                radius="md"
                value={interval}
                onChange={(value) => onIntervalChange(value as 'month' | 'year')}
                size="md"
                data={[
                  { value: 'month', label: 'Monthly Plans' },
                  {
                    value: 'year',
                    label: (
                      <Center>
                        <Box mr={6}>Annual Plans</Box>
                        <Badge p={5} color="green" className="flex" variant="filled" radius="xl">
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
              <Group gap="xs" wrap="nowrap" align="flex-start">
                <Text size="md">
                  You&rsquo;re currently on an annual plan. You can upgrade to a different annual
                  plan or cancel your current one at any time. However, switching to a monthly plan
                  requires canceling your membership first and waiting for it to expire before
                  signing up again.
                </Text>
              </Group>
            </AlertWithIcon>
          )}

          <Text className="text-center">
            All memberships displayed below grant{' '}
            <Text component="span" fw={700} className="text-buzz">
              Green Buzz
            </Text>{' '}
          </Text>

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
            <ContainerGrid2 justify="center">
              <ContainerGrid2.Col span={{ base: 12, sm: 6, md: 3 }}>
                <Card className={classes.card}>
                  <Stack style={{ height: '100%' }}>
                    <Stack gap="md" mb="md">
                      <Title className={clsx(classes.cardTitle, 'text-center')} order={2} mb="sm">
                        Free
                      </Title>
                      <Center style={{ opacity: 0.3 }}>
                        <EdgeMedia
                          src={freePlanDetails.image}
                          width={128}
                          className={classes.image}
                        />
                      </Center>
                      <Group justify="center" gap={4} align="flex-end" mb={24}>
                        <Text className={classes.price} align="center" lh={1} mt={undefined}>
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
              </ContainerGrid2.Col>
              {products.map((product) => (
                <ContainerGrid2.Col key={product.id} span={{ base: 12, sm: 6, md: 3 }}>
                  <PlanCard
                    key={`${interval}-${product.id}`}
                    product={product}
                    subscription={subscription}
                  />
                </ContainerGrid2.Col>
              ))}
            </ContainerGrid2>
          )}

          {!isLoading && (
            <Stack gap={0}>
              <p className="mb-0 text-xs opacity-50">
                By purchasing a membership, you agree to our{' '}
                <Anchor href="/content/tos" inherit>
                  Terms of Service
                </Anchor>
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
