import {
  Alert,
  Button,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconArrowRight, IconCircleCheck } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PlanCard } from '~/components/Stripe/PlanCard';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

export default function Confirm() {
  const currentUser = useCurrentUser();
  const isMember = currentUser?.tier !== undefined;
  const router = useRouter();
  const queryUtils = trpc.useContext();
  const [email, setEmail] = useState(currentUser?.email);
  const { data: air, isLoading } = trpc.integration.airStatus.useQuery(undefined, {
    enabled: !!currentUser,
  });
  const { data: products, isLoading: productsLoading } = trpc.stripe.getPlans.useQuery(undefined, {
    enabled: !isMember,
  });
  const { subscription, subscriptionLoading } = useActiveSubscription();

  const confirmMutation = trpc.integration.airConfirm.useMutation({
    async onSuccess(data) {
      queryUtils.integration.airStatus.setData(undefined, () => data);
    },
  });

  if (!currentUser) {
    if (typeof window === 'undefined') return null;
    router.replace(getLoginLink({ reason: 'confirm-membership', returnUrl: '/air/confirm' }));
    return null;
  }

  const confirmEmail = (
    <Container size="xs">
      <Stack>
        <Text size="xl" weight={500} ta="center">{`Thanks for being a Civitai Supporter ❤️`}</Text>
        <Text>{`To complete your application, please enter the email that you used when you applied for the Artist in Residence program`}</Text>
        <Stack spacing={5}>
          <TextInput
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            size="xl"
          />
          <Button
            size="lg"
            onClick={() => {
              if (!email) return;
              confirmMutation.mutate({ email });
            }}
            loading={confirmMutation.isLoading}
          >
            Confirm Email
          </Button>
        </Stack>
      </Stack>
    </Container>
  );

  const confirmed = (
    <Container size="xs">
      <Stack>
        <Text size="xl" weight={500} ta="center">{`Thanks for being a Civitai Member ❤️`}</Text>
        <Alert color="green" my="lg">
          <Group noWrap>
            <ThemeIcon size={46} color="green">
              <IconCircleCheck size={30} />
            </ThemeIcon>
            <Text size="xl" sx={{ lineHeight: 1.2 }}>{`Your membership has been confirmed`}</Text>
          </Group>
        </Alert>
        <Button
          component="a"
          href="https://air.civitai.com/application-success"
          rightIcon={<IconArrowRight />}
          size="lg"
        >
          Return to AiR Application
        </Button>
      </Stack>
    </Container>
  );

  const subscriptionsLoading = subscriptionLoading || productsLoading;
  const notMember = (
    <Stack>
      <Text size="xl" weight={500} ta="center">{`Become a Supporter today!`}</Text>
      {subscriptionsLoading ? (
        <Loader />
      ) : (
        <ContainerGrid justify="center">
          {products?.map((product) => (
            <ContainerGrid.Col key={product.id} md={4} sm={6} xs={12}>
              <PlanCard product={product} subscription={subscription} />
            </ContainerGrid.Col>
          ))}
        </ContainerGrid>
      )}
    </Stack>
  );

  if (isLoading || !air) return <PageLoader />;

  const isConfirmed = air.status === 'connected';
  return (
    <Container>
      <Title order={1} align="center" mb="lg">
        AiR Supporter Confirmation
      </Title>
      {!isMember ? notMember : isConfirmed ? confirmed : confirmEmail}
    </Container>
  );
}
