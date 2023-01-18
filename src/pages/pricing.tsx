import { InferGetStaticPropsType } from 'next';

import { Card, Container, createStyles, Title, Text, Button, Stack } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { getPlans } from '~/server/services/stripe.service';
import { trpc } from '~/utils/trpc';
import { getClientStripe } from '~/utils/get-client-stripe';

const maxColumns = 3;

export default function Pricing({ plans }: InferGetStaticPropsType<typeof getStaticProps>) {
  const user = useCurrentUser();
  const { classes } = useStyles();
  const router = useRouter();

  const { mutate, isLoading } = trpc.stripe.createSubscriptionSession.useMutation({
    async onSuccess({ sessionId }) {
      console.log({ sessionId });
      const stripe = await getClientStripe();
      await stripe.redirectToCheckout({ sessionId });
    },
  });

  const processSubscription = async (priceId: string) => {
    mutate({ priceId });
  };

  // TODO - add button functionality
  const showSubscribeButton = !!user && !user.subscription;
  const showSignIn = !user;
  const showManageSubscription = !!user && !!user.subscription;

  return (
    <Container>
      <Title>Pricing</Title>
      <div className={classes.grid}>
        {plans.map((plan) => (
          <Card key={plan.priceId} className={classes.flexItem} withBorder>
            <Stack>
              <Title order={2}>{plan.name}</Title>
              <Text>
                ${plan.price / 100} / {plan.interval}
              </Text>
              {showSubscribeButton && (
                <Button onClick={() => processSubscription(plan.priceId)} loading={isLoading}>
                  Subscribe
                </Button>
              )}
              {showSignIn && (
                <Link href={`/login?returnUrl=${router.asPath}`} passHref>
                  <Button component="a">Sign in</Button>
                </Link>
              )}
              {showManageSubscription && plan.priceId === user.subscription && (
                <Button>Manage Subscription</Button>
              )}
            </Stack>
          </Card>
        ))}
      </div>
    </Container>
  );
}

// TODO - style
const useStyles = createStyles((theme) => {
  const gap = theme.spacing.md;
  return {
    grid: {
      // display: 'grid',
      // gridTemplateColumns: `repeat(auto-fill, minmax(max(250px, calc(100%/${maxColumns} - ${theme.spacing.md})), 1fr));`,
      // gridGap: theme.spacing.md,
      display: 'flex',
      flexWrap: 'wrap',
      gap: gap,
    },
    flexItem: {
      width: `calc(100% / ${maxColumns} - ${gap * ((maxColumns - 1) / maxColumns)}px)`,
    },
  };
});

export const getStaticProps = async () => {
  const plans = await getPlans();
  return {
    props: {
      plans,
    },
  };
};
