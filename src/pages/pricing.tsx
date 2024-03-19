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
  Anchor,
} from '@mantine/core';
import { trpc } from '~/utils/trpc';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PlanCard } from '~/components/Stripe/PlanCard';
import {
  IconCalendarDue,
  IconExclamationMark,
  IconHeartHandshake,
  IconInfoCircle,
} from '@tabler/icons-react';
import { DonateButton } from '~/components/Stripe/DonateButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { PlanBenefitList } from '~/components/Stripe/PlanBenefitList';
import { joinRedirectReasons, JoinRedirectReason } from '~/utils/join-helpers';
import { useRouter } from 'next/router';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';

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
  const currentMembershipUnavailable =
    !!subscription &&
    !productsLoading &&
    !(products ?? []).find((p) => p.id === subscription.product.id);

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
        <Tabs variant="pills" defaultValue="subscribe" radius="xl" color="gray">
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
              {currentMembershipUnavailable && (
                <AlertWithIcon color="yellow" iconColor="yellow" icon={<IconInfoCircle />}>
                  <Text>
                    We have stopped offering the membership plan you are in. You can view your
                    current benefits and manage your membership details by clicking{' '}
                    <Anchor href="/user/membership">here</Anchor>.
                  </Text>
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
                  {products.map((product) => (
                    <ContainerGrid.Col key={product.id} md={4} sm={6} xs={12}>
                      <PlanCard product={product} subscription={subscription} />
                    </ContainerGrid.Col>
                  ))}
                </ContainerGrid>
              )}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="donate" pt="md">
            <ContainerGrid justify="center">
              <ContainerGrid.Col md={4} sm={6} xs={12}>
                <Card className={classes.card}>
                  <Stack justify="space-between" style={{ height: '100%' }}>
                    <Stack spacing="md" mb="md">
                      <Title className={classes.cardTitle} order={2} align="center">
                        One-time Donation
                      </Title>
                      <Center>
                        <EdgeMedia
                          src="ab3e161b-7c66-4412-9573-ca16dde9f900"
                          className={classes.image}
                          width={128}
                        />
                      </Center>
                      <DonateButton>
                        <Button radius="xl">Donate</Button>
                      </DonateButton>
                    </Stack>
                    <PlanBenefitList
                      benefits={[
                        { content: 'Unique Donator badge' },
                        { content: 'Unique nameplate color' },
                        { content: 'Unique Discord role for 30 days' },
                      ]}
                      useDefaultBenefits={false}
                    />
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
  card: {
    height: '100%',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
  },
}));

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.stripe.getPlans.prefetch();
    await ssg?.stripe.getUserSubscription.prefetch();
  },
});
