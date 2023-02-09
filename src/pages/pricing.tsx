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
  Grid,
  Tabs,
  List,
  ThemeIcon,
  Group,
} from '@mantine/core';
import { trpc } from '~/utils/trpc';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { PlanDetails } from '~/components/Stripe/PlanDetails';
import { ManageSubscriptionButton } from '~/components/Stripe/ManageSubscriptionButton';
import { IconCalendarDue, IconCircleCheck, IconExclamationMark, IconHeartHandshake } from '@tabler/icons';
import { DonateButton } from '~/components/Stripe/DonateButton';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { PlanBenefitList } from '~/components/Stripe/PlanBenefitList';
import { joinRedirectReasons, JoinRedirectReason } from '~/utils/join-helpers';
import { useRouter } from 'next/router';

export default function Pricing() {
  const router = useRouter();
  const {
    returnUrl = '/',
    reason,
  } = router.query as { returnUrl: string; reason: JoinRedirectReason };
  const redirectReason = joinRedirectReasons[reason];

  const { data: products, isLoading: productsLoading } = trpc.stripe.getPlans.useQuery();
  const { data: subscription, isLoading: subscriptionLoading } =
    trpc.stripe.getUserSubscription.useQuery();

  const isLoading = productsLoading || subscriptionLoading;
  const showSubscribeButton = !subscription;

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
          <Title align="center">Support Us ❤️</Title>
          <Text align="center" sx={{ lineHeight: 1.25 }}>
            {`As the leading model sharing service, we're proud to be ad-free and adding new features every week. Help us keep the community thriving by becoming a member or making a donation. Support Civitai and get exclusive perks.`}
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
                <Grid justify="center">
                  {products.map((product) => (
                    <Grid.Col key={product.id} md={4} sm={6} xs={12}>
                      <Card withBorder style={{ height: '100%' }}>
                        <Stack justify="space-between" style={{ height: '100%' }}>
                          <PlanDetails
                            name={product.name}
                            description={product.description}
                            unitAmount={product.price.unitAmount}
                            currency={product.price.currency}
                            interval={product.price.interval}
                          />
                          {showSubscribeButton && (
                            <SubscribeButton priceId={product.price.id}>
                              <Button>Subscribe</Button>
                            </SubscribeButton>
                          )}
                        </Stack>
                      </Card>
                    </Grid.Col>
                  ))}
                </Grid>
              )}
              {!!subscription && (
                <Center>
                  <ManageSubscriptionButton>
                    <Button>Manage your Membership</Button>
                  </ManageSubscriptionButton>
                </Center>
              )}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="donate" pt="md">
            <Grid justify="center">
              <Grid.Col md={4} sm={6} xs={12}>
                <Card withBorder style={{ height: '100%' }}>
                  <Stack justify="space-between" style={{ height: '100%' }}>
                    <Stack spacing={0} mb="md">
                      <Center>
                        <EdgeImage src="ab3e161b-7c66-4412-9573-ca16dde9f900" width={128} />
                      </Center>
                      <Title order={2} align="center">
                        One-time Donation
                      </Title>
                    </Stack>
                    <PlanBenefitList
                      benefits={[
                        { content: 'Unique Donator badge' },
                        { content: 'Unique nameplate color' },
                      ]}
                    />
                    <DonateButton>
                      <Button>Donate</Button>
                    </DonateButton>
                  </Stack>
                </Card>
              </Grid.Col>
            </Grid>
          </Tabs.Panel>
        </Tabs>
      </Container>
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.stripe.getPlans.prefetch();
    await ssg?.stripe.getUserSubscription.prefetch();
  },
});
