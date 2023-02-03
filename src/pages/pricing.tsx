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
} from '@mantine/core';
import { trpc } from '~/utils/trpc';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { PlanDetails } from '~/components/Stripe/PlanDetails';
import { ManageSubscriptionButton } from '~/components/Stripe/ManageSubscriptionButton';

export default function Pricing() {
  const { data: products, isLoading: productsLoading } = trpc.stripe.getPlans.useQuery();
  const { data: subscription, isLoading: subscriptionLoading } =
    trpc.stripe.getUserSubscription.useQuery();

  // TODO - add button functionality
  const isLoading = productsLoading || subscriptionLoading;
  const showSubscribeButton = !subscription;

  return (
    <>
      <Container size="sm" mb="md">
        <Stack>
          <Title align="center">Support us</Title>
          <Text align="center">
            {`Civitai is the number one model repository and sharing service, its ad free and new
          features are being added weekly. We love what this resource has become and the diverse
          community we've grown! We don't believe in asking for something for nothing, so for now we
          have two ways for you to support us while nabbing some perks for yourself!`}
          </Text>
        </Stack>
      </Container>
      <Container>
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
                <Grid.Col key={product.id} md={5} sm={6} xs={12}>
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
                <Button>Manage your Subscription</Button>
              </ManageSubscriptionButton>
            </Center>
          )}
        </Stack>
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
