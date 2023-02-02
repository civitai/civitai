import {
  Card,
  Container,
  createStyles,
  Title,
  Text,
  Button,
  Stack,
  Center,
  Loader,
  Alert,
} from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { trpc } from '~/utils/trpc';
import { getClientStripe } from '~/utils/get-client-stripe';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export default function Pricing() {
  const user = useCurrentUser();
  const { classes } = useStyles();
  const router = useRouter();

  const { data: products, isLoading: productsLoading } = trpc.stripe.getPlans.useQuery();
  const { data: subscription, isLoading: subscriptionLoading } =
    trpc.stripe.getUserSubscription.useQuery();
  const { mutate, isLoading: sessionLoading } = trpc.stripe.createSubscriptionSession.useMutation({
    async onSuccess({ sessionId }) {
      const stripe = await getClientStripe();
      await stripe.redirectToCheckout({ sessionId });
    },
  });

  const processSubscription = async (priceId: string) => {
    mutate({ priceId });
  };

  // TODO - add button functionality
  const isLoading = productsLoading || subscriptionLoading;
  const showSubscribeButton = !!user && !subscription;
  const showSignIn = !user;
  const showManageSubscription = !!user?.subscriptionId;

  return (
    <Container>
      <Stack>
        <Title align="center">Support us</Title>
        <Text align="center">
          {`Civitai is the number one model repository and sharing service, its ad free and new
          features are being added weekly. We love what this resource has become and the diverse
          community we've grown! We don't believe in asking for something for nothing, so for now we
          have two ways for you to support us while nabbing some perks for yourself!`}
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
          <div className={classes.grid}>
            {products.map((product) => (
              <Card key={product.id} className={classes.flexItem} withBorder>
                <Stack>
                  <Title order={2}>{product.name}</Title>
                  <Text>
                    ${product.price.unitAmount / 100} / {product.price.interval}
                  </Text>
                  {showSubscribeButton && (
                    <Button
                      onClick={() => processSubscription(product.price.id)}
                      loading={sessionLoading}
                    >
                      Subscribe
                    </Button>
                  )}
                  {showSignIn && (
                    <Link href={`/login?returnUrl=${router.asPath}`} passHref>
                      <Button component="a">Sign in</Button>
                    </Link>
                  )}
                  {/* TODO.stripe - show different options if they have cancelled their subscription */}
                  {/* {showManageSubscription && product.id === subscription?.product.id && (
                    <Button>Manage Subscription</Button>
                  )} */}
                </Stack>
              </Card>
            ))}
          </div>
        )}
      </Stack>
    </Container>
  );
}

// TODO - style
const useStyles = createStyles((theme) => {
  const maxColumns = 3;
  const gap = theme.spacing.md;
  return {
    grid: {
      // display: 'grid',
      // gridTemplateColumns: `repeat(auto-fill, minmax(max(250px, calc(100%/${maxColumns} - ${theme.spacing.md})), 1fr));`,
      // gridGap: theme.spacing.md,
      display: 'flex',
      flexWrap: 'wrap',
      gap: gap,
      justifyContent: 'center',
    },
    flexItem: {
      width: `calc(100% / ${maxColumns} - ${gap * ((maxColumns - 1) / maxColumns)}px)`,
    },
  };
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.stripe.getPlans.prefetch();
    await ssg?.stripe.getUserSubscription.prefetch();
  },
});
