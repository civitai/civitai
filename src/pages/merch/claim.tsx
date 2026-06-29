import {
  Alert,
  Button,
  Center,
  Container,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconBolt, IconCheck, IconMail } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useEffect, useRef, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.buzz) return { notFound: true };
    if (!session)
      return {
        redirect: { destination: getLoginLink({ returnUrl: ctx.resolvedUrl }), permanent: false },
      };
  },
});

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <>
    <Meta title="Claim your Buzz reward" deIndex />
    <Container size="xs" py="xl">
      <Stack gap="lg">
        <Title order={2}>Claim your Buzz reward</Title>
        {children}
      </Stack>
    </Container>
  </>
);

const GrantedMessage = ({ buzz }: { buzz: number }) => (
  <Alert color="green" icon={<IconCheck size={18} />} title="Buzz added!">
    <Stack gap="sm">
      <Text>
        {buzz > 0
          ? `⚡${buzz.toLocaleString()} Blue Buzz has been added to your account.`
          : 'Your merch orders are linked. Buzz from any new orders will be added automatically.'}
      </Text>
      <Button component={NextLink} href="/" variant="light" w="fit-content">
        Done
      </Button>
    </Stack>
  </Alert>
);

function ConfirmFlow({ token }: { token: string }) {
  const ran = useRef(false);
  const confirm = trpc.merch.confirmClaim.useMutation();

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    confirm.mutate({ token });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!confirm.data && !confirm.error)
    return (
      <Center>
        <Loader />
      </Center>
    );
  if (confirm.error)
    return (
      <Alert color="red" title="Couldn't confirm">
        {confirm.error.message}
      </Alert>
    );
  return <GrantedMessage buzz={confirm.data?.grantedBuzz ?? 0} />;
}

function ClaimFlow({ shopifyOrderId }: { shopifyOrderId: string }) {
  const [email, setEmail] = useState('');
  const utils = trpc.useUtils();
  const orderQuery = trpc.merch.getClaimableOrder.useQuery({ shopifyOrderId });
  const claim = trpc.merch.claim.useMutation({
    onSuccess: () => utils.merch.getClaimableOrder.invalidate({ shopifyOrderId }),
  });
  const requestConfirm = trpc.merch.requestEmailConfirmation.useMutation();

  if (orderQuery.isLoading)
    return (
      <Center>
        <Loader />
      </Center>
    );

  const order = orderQuery.data;
  if (!order || !order.found)
    return (
      <Alert color="yellow" title="Order not found">
        We couldn&apos;t find that order yet. If you just checked out, give it a minute and refresh
        — orders appear here once payment is confirmed.
      </Alert>
    );

  if (order.alreadyClaimed || claim.data?.status === 'already_claimed')
    return (
      <Alert color="blue" title="Already claimed">
        This order&apos;s Buzz has already been claimed.
      </Alert>
    );

  if (claim.data?.status === 'granted') return <GrantedMessage buzz={claim.data.grantedBuzz} />;

  if (requestConfirm.data?.status === 'confirmation_sent')
    return (
      <Alert color="green" icon={<IconMail size={18} />} title="Check your email">
        We sent a confirmation link to <strong>{requestConfirm.data.maskedEmail}</strong>. Click it
        (while signed in here) to add your Buzz and link your store orders.
      </Alert>
    );

  const buzz = order.buzzAmount;

  // Email on the order matches your verified Civitai email → one-click claim.
  if (order.emailMatches)
    return (
      <Stack gap="md">
        <Text>
          You&apos;ve got <strong>⚡{buzz.toLocaleString()} Blue Buzz</strong> waiting from this
          merch order.
        </Text>
        <Button
          leftSection={<IconBolt size={18} fill="currentColor" />}
          loading={claim.isPending}
          onClick={() => claim.mutate({ shopifyOrderId })}
          w="fit-content"
        >
          Claim {buzz.toLocaleString()} Buzz
        </Button>
        {claim.error && (
          <Text c="red" size="sm">
            {claim.error.message}
          </Text>
        )}
      </Stack>
    );

  // Mismatch: the order used a different email than your account. Confirm via email.
  return (
    <Stack gap="md">
      <Text>
        This order has <strong>⚡{buzz.toLocaleString()} Blue Buzz</strong>, but it was placed with
        a different email than your Civitai account. Enter the email you used at checkout and
        we&apos;ll send a confirmation link to verify it&apos;s you.
      </Text>
      <TextInput
        label="Email used on the order"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.currentTarget.value)}
        type="email"
      />
      <Button
        leftSection={<IconMail size={18} />}
        loading={requestConfirm.isPending}
        disabled={!email}
        onClick={() => requestConfirm.mutate({ shopifyOrderId, email })}
        w="fit-content"
      >
        Send confirmation
      </Button>
      {requestConfirm.error && (
        <Text c="red" size="sm">
          {requestConfirm.error.message}
        </Text>
      )}
    </Stack>
  );
}

export default function MerchClaimPage() {
  const router = useRouter();
  const token = typeof router.query.token === 'string' ? router.query.token : undefined;
  const order = typeof router.query.order === 'string' ? router.query.order : undefined;

  if (token)
    return (
      <Wrapper>
        <ConfirmFlow token={token} />
      </Wrapper>
    );
  if (order)
    return (
      <Wrapper>
        <ClaimFlow shopifyOrderId={order} />
      </Wrapper>
    );

  return (
    <Wrapper>
      <Alert color="yellow" title="No order specified">
        Open this page from the link on your order confirmation to claim your Buzz.
      </Alert>
    </Wrapper>
  );
}
