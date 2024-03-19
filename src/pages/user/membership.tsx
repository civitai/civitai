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
import { IconDotsVertical, IconRotateClockwise } from '@tabler/icons-react';
import { ProductMetadata } from '~/server/schema/stripe.schema';
import { constants } from '~/server/common/constants';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { CancelMembershipFeedbackModal } from '~/components/Stripe/MembershipChangePrevention';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { ManageSubscriptionButton } from '~/components/Stripe/ManageSubscriptionButton';

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

export default function UserMembership() {
  const { classes, theme } = useStyles();
  const { data: subscription, isLoading } = trpc.stripe.getUserSubscription.useQuery();
  const features = useFeatureFlags();

  if (isLoading || !subscription) {
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
  const productMeta = (product.metadata ?? {}) as ProductMetadata;
  const canUpgrade =
    productMeta.tier !==
    constants.memberships.tierOrder[constants.memberships.tierOrder.length - 1];

  return (
    <>
      <Meta title="My Membership" deIndex="noindex, nofollow" />
      <Container size="md">
        <Grid>
          <Grid.Col span={12}>
            <Stack>
              <Title>My Membership Plan</Title>
              <Paper withBorder className={classes.card}>
                <Stack>
                  <Group position="apart">
                    <Group noWrap>
                      {image && (
                        <Center>
                          <EdgeMedia src={image} width={100} />
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
                        <SubscribeButton priceId={price.id}>
                          <Button radius="xl" rightIcon={<IconRotateClockwise size={16} />}>
                            Resume
                          </Button>
                        </SubscribeButton>
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
                            <Menu.Item>Manage</Menu.Item>
                          </ManageSubscriptionButton>
                          {!subscription?.canceledAt && (
                            <Menu.Item
                              onClick={() => {
                                dialogStore.trigger({
                                  component: CancelMembershipFeedbackModal,
                                });
                              }}
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
