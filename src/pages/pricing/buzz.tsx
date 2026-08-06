import { Alert, Center, Container, Loader, Stack, Text, Title } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { Meta } from '~/components/Meta/Meta';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { BuzzMembershipCallout } from '~/components/Subscriptions/BuzzMembershipCallout';
import { PlanCard } from '~/components/Subscriptions/PlanCard';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.buzzMemberships) return { notFound: true };
    if (!session || !session.user)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
  },
});

export default function BuzzMembershipPurchasePage() {
  // Same cards as /pricing, fed the Buzz catalog. PlanCard already knows how to render a
  // Buzz product: Buzz price, "Get X with Buzz" purchase button, Creator Program crossed out.
  const { data: products, isLoading } = trpc.subscriptions.getPlans.useQuery({
    interval: 'month',
    buzzPurchase: true,
    paymentProvider: 'Civitai',
  });

  const { subscription } = useActiveSubscription({
    checkWhenInBadState: true,
    includeBuzzPurchase: true,
  });

  return (
    <>
      <Meta title="Perks Memberships | Civitai" deIndex />
      <Container size="xl" className="my-8">
        <Stack gap="lg">
          <Stack gap={4} align="center">
            <Title order={1} className="text-center text-3xl font-bold sm:text-4xl">
              Perks Memberships
            </Title>
            <Text size="md" c="dimmed" className="text-center">
              Spend the Buzz you&rsquo;ve earned on a month of membership perks
            </Text>
          </Stack>

          <BuzzMembershipCallout />

          {isLoading ? (
            <Center p="xl">
              <Loader />
            </Center>
          ) : !products?.length ? (
            <Alert color="yellow" icon={<IconInfoCircle size={20} />}>
              There are no perks memberships available right now.
            </Alert>
          ) : (
            <ContainerGrid2 justify="center">
              {products.map((product) => (
                <ContainerGrid2.Col
                  key={product.id}
                  span={{ base: 12, sm: 6, md: Math.max(3, 12 / products.length) }}
                >
                  <PlanCard product={product} subscription={subscription} />
                </ContainerGrid2.Col>
              ))}
            </ContainerGrid2>
          )}
        </Stack>
      </Container>
    </>
  );
}
