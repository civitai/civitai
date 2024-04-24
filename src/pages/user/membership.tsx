import {
  Container,
  Stack,
  Title,
  createStyles,
  Grid,
  Paper,
  Center,
  Loader,
  Text,
  Group,
  Button,
  Menu,
  ActionIcon,
  Box,
  Alert,
  Anchor,
  Tooltip,
} from '@mantine/core';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { Meta } from '~/components/Meta/Meta';
import { getStripeCurrencyDisplay } from '~/utils/string-helpers';
import { shortenPlanInterval } from '~/components/Stripe/stripe.utils';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink } from '@mantine/next';
import { trpc } from '~/utils/trpc';
import { getPlanDetails } from '~/components/Stripe/PlanCard';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { PlanBenefitList } from '~/components/Stripe/PlanBenefitList';
import {
  IconDotsVertical,
  IconInfoCircle,
  IconInfoTriangleFilled,
  IconRotateClockwise,
} from '@tabler/icons-react';
import { ProductMetadata } from '~/server/schema/stripe.schema';
import { constants } from '~/server/common/constants';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { CancelMembershipFeedbackModal } from '~/components/Stripe/MembershipChangePrevention';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { ManageSubscriptionButton } from '~/components/Stripe/ManageSubscriptionButton';
import { useActiveSubscription, useCanUpgrade } from '~/components/Stripe/memberships.util';
import { useRouter } from 'next/router';
import { userTierSchema } from '~/server/schema/user.schema';
import { z } from 'zod';
import { capitalize } from 'lodash';
import { booleanString } from '~/utils/zod-helpers';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';

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

    if (!session.user.subscriptionId)
      return {
        redirect: {
          destination: '/pricing',
          permanent: false,
        },
      };
  },
});

const useStyles = createStyles((theme) => ({
  card: {
    height: '100%',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
  },
  price: {
    fontSize: 48,
    fontWeight: 700,
  },
}));

const querySchema = z.object({
  downgraded: booleanString().optional(),
  tier: userTierSchema.optional(),
});

export default function UserMembership() {
  const { classes, theme } = useStyles();
  const { subscription, subscriptionLoading } = useActiveSubscription({
    checkWhenInBadState: true,
  });
  const features = useFeatureFlags();
  const canUpgrade = useCanUpgrade();
  const router = useRouter();
  const query = querySchema.safeParse(router.query);
  const isDrowngrade = query.success ? query.data?.downgraded : false;
  const downgradedTier = query.success ? isDrowngrade && query.data?.tier : null;

  if (subscriptionLoading || !subscription) {
    return (
      <Container size="lg">
        <Center>
          <Loader />
        </Center>
      </Container>
    );
  }

  const price = subscription.price;
  const product = subscription.product;
  const { image, benefits } = getPlanDetails(subscription.product, features);
  console.log(price);

  return (
    <>
      <Meta title="My Membership" deIndex={true} />
      <Container size="md">
        <Grid>
          <Grid.Col span={12}>
            <Stack>
              <Title>My Membership Plan</Title>
              {isDrowngrade && downgradedTier && (
                <Alert>
                  You have successfully downgraded your membership to the{' '}
                  {capitalize(downgradedTier)} tier. It may take a few seconds for your new plan to
                  take effect. You may refresh the page to see the changes.
                </Alert>
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
                      Uh oh! It looks like there was an issue with your membership. You can update
                      your payment method or renew your membership now by clicking{' '}
                      <SubscribeButton priceId={subscription.price.id}>
                        <Anchor component="button" type="button">
                          here
                        </Anchor>
                      </SubscribeButton>
                    </Text>
                  </Stack>
                </AlertWithIcon>
              )}
              <Paper withBorder className={classes.card}>
                <Stack>
                  <Group position="apart">
                    <Group noWrap>
                      {image && (
                        <Center>
                          <Box w={100}>
                            <EdgeMedia src={image} width="original" />
                          </Box>
                        </Center>
                      )}
                      <Stack spacing={0}>
                        {product && (
                          <Text weight={600} size={20}>
                            {product.name}
                          </Text>
                        )}
                        {price && (
                          <Text>
                            <Text component="span" className={classes.price}>
                              {getStripeCurrencyDisplay(price.unitAmount, price.currency)}
                            </Text>{' '}
                            <Text component="span" color="dimmed" size="sm">
                              {price.currency.toUpperCase() +
                                '/' +
                                shortenPlanInterval(price.interval)}
                            </Text>
                          </Text>
                        )}
                      </Stack>
                    </Group>
                    <Group>
                      {subscription.canceledAt && (
                        <>
                          {price.active && (
                            <SubscribeButton priceId={price.id}>
                              <Button radius="xl" rightIcon={<IconRotateClockwise size={16} />}>
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
                              <ActionIcon variant="light" color="dark" size="lg">
                                <IconInfoCircle color="white" strokeWidth={2.5} size={26} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </>
                      )}
                      {canUpgrade && (
                        <Button component={NextLink} href="/pricing" radius="xl">
                          Upgrade
                        </Button>
                      )}
                      <Menu position="bottom" withinPortal closeOnItemClick={false}>
                        <Menu.Target>
                          <ActionIcon
                            size={30}
                            radius="xl"
                            color="gray"
                            variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                            ml="auto"
                          >
                            <IconDotsVertical size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <ManageSubscriptionButton>
                            <Menu.Item>View Details</Menu.Item>
                          </ManageSubscriptionButton>
                          {!subscription?.canceledAt && (
                            <Menu.Item
                              onClick={() => {
                                dialogStore.trigger({
                                  component: CancelMembershipFeedbackModal,
                                });
                              }}
                              closeMenuOnClick={true}
                            >
                              Cancel Membership
                            </Menu.Item>
                          )}
                        </Menu.Dropdown>
                      </Menu>
                    </Group>
                  </Group>
                </Stack>
              </Paper>

              {benefits && (
                <>
                  <Title order={3}>Your membership benefits</Title>
                  <Paper withBorder className={classes.card}>
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
