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
  Tabs,
  List,
  ThemeIcon,
  Group,
  createStyles,
} from '@mantine/core';
import { trpc } from '~/utils/trpc';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { PlanCard } from '~/components/Stripe/PlanCard';
import { ManageSubscriptionButton } from '~/components/Stripe/ManageSubscriptionButton';
import {
  IconCalendarDue,
  IconCircleCheck,
  IconExclamationMark,
  IconHeartHandshake,
} from '@tabler/icons-react';
import { DonateButton } from '~/components/Stripe/DonateButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { PlanBenefitList } from '~/components/Stripe/PlanBenefitList';
import { joinRedirectReasons, JoinRedirectReason } from '~/utils/join-helpers';
import { useRouter } from 'next/router';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { containerQuery } from '~/utils/mantine-css-helpers';

export default function Pricing() {
  const router = useRouter();
  const { classes, cx } = useStyles();
  const { returnUrl = '/', reason } = router.query as {
    returnUrl: string;
    reason: JoinRedirectReason;
  };
  const redirectReason = joinRedirectReasons[reason];

  const { data: products, isLoading: productsLoading } = trpc.stripe.getPlans.useQuery();
  const { data: subscription, isLoading: subscriptionLoading } =
    trpc.stripe.getUserSubscription.useQuery();

  const isLoading = productsLoading || subscriptionLoading;
  const showSubscribeButton = !subscription || !!subscription.canceledAt;

  return (
    <>
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
            Support Us ❤️
          </Title>
          <Text align="center" className={classes.introText} sx={{ lineHeight: 1.25 }}>
            {`As the leading model sharing service, we're adding new features every week. Help us keep the community thriving by becoming a member or making a donation. Support Civitai and get exclusive perks.`}
          </Text>
        </Stack>
      </Container>
      <Container>
        <Tabs variant="outline" defaultValue="subscribe">
          <Tabs.List position="center">
            <Tabs.Tab value="subscribe" icon={<IconCalendarDue size={20} />}>
              Membership
            </Tabs.Tab>
            <Tabs.Tab value="donate" icon={<IconHeartHandshake size={20} />}>
              Donate
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="subscribe" pt="md">
            <Stack>
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
                  {products.map((product) => (
                    <ContainerGrid.Col key={product.id} md={4} sm={6} xs={12}>
                      <PlanCard product={product} subscription={subscription} />
                    </ContainerGrid.Col>
                  ))}
                </ContainerGrid>
              )}
              {!showSubscribeButton && (
                <Center>
                  <ManageSubscriptionButton>
                    <Button>Manage your Membership</Button>
                  </ManageSubscriptionButton>
                </Center>
              )}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="donate" pt="md">
            <ContainerGrid justify="center">
              <ContainerGrid.Col md={4} sm={6} xs={12}>
                <Card withBorder style={{ height: '100%' }}>
                  <Stack justify="space-between" style={{ height: '100%' }}>
                    <Stack spacing={0} mb="md">
                      <Center>
                        <EdgeMedia
                          src="ab3e161b-7c66-4412-9573-ca16dde9f900"
                          className={classes.image}
                          width={128}
                        />
                      </Center>
                      <Title className={classes.cardTitle} order={2} align="center">
                        One-time Donation
                      </Title>
                    </Stack>
                    <PlanBenefitList
                      benefits={[
                        { content: 'Unique Donator badge' },
                        { content: 'Unique nameplate color' },
                        { content: 'Unique Discord role for 30 days' },
                      ]}
                    />
                    <DonateButton>
                      <Button>Donate</Button>
                    </DonateButton>
                  </Stack>
                </Card>
              </ContainerGrid.Col>
            </ContainerGrid>
          </Tabs.Panel>
        </Tabs>
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
}));
