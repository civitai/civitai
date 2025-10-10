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
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PlanCard } from '~/components/Subscriptions/PlanCard';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';

export default function Confirm() {
  const currentUser = useCurrentUser();
  const isMember = currentUser?.tier !== undefined;
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const [email, setEmail] = useState(currentUser?.email);
  const paymentProvider = usePaymentProvider();
  const { data: air, isLoading } = trpc.integration.airStatus.useQuery(undefined, {
    enabled: !!currentUser,
  });
  const { data: products, isLoading: productsLoading } = trpc.subscriptions.getPlans.useQuery(
    { paymentProvider },
    {
      enabled: !isMember,
    }
  );
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
        <Text size="xl" fw={500} ta="center">{`Thanks for being a Civitai Member ❤️`}</Text>
        <Text>{`To complete your application, please enter the email that you used when you applied for the Artist in Residence program`}</Text>
        <Stack gap={5}>
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
        <Text size="xl" fw={500} ta="center">{`Thanks for being a Civitai Member ❤️`}</Text>
        <Alert color="green" my="lg">
          <Group wrap="nowrap">
            <ThemeIcon size={46} color="green">
              <IconCircleCheck size={30} />
            </ThemeIcon>
            <Text
              size="xl"
              style={{ lineHeight: 1.2 }}
            >{`Your membership has been confirmed`}</Text>
          </Group>
        </Alert>
        <Button
          component="a"
          href="https://studio.civitai.com/cohort-application/success"
          rightSection={<IconArrowRight />}
          size="lg"
        >
          Return to Studio Cohort Application
        </Button>
      </Stack>
    </Container>
  );

  const subscriptionsLoading = subscriptionLoading || productsLoading;
  const notMember = (
    <Stack>
      <Text size="xl" fw={500} ta="center">{`Become a Member today!`}</Text>
      {subscriptionsLoading ? (
        <Loader />
      ) : (
        <ContainerGrid2 justify="center">
          {products?.map((product) => (
            <ContainerGrid2.Col key={product.id} span={{ base: 12, xs: 6, sm: 4 }}>
              <PlanCard product={product} subscription={subscription} />
            </ContainerGrid2.Col>
          ))}
        </ContainerGrid2>
      )}
    </Stack>
  );

  if (isLoading || !air) return <PageLoader />;

  const isConfirmed = air.status === 'connected';
  return (
    <Container>
      <Title order={1} className="text-center" mb="lg">
        Studio Member Confirmation
      </Title>
      {!isMember ? notMember : isConfirmed ? confirmed : confirmEmail}
    </Container>
  );
}
