import { Alert, Button, Center, Container, Loader, Stack, Text, Title } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useEffect, useRef } from 'react';
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

function KeyFlow({ orderKey }: { orderKey: string }) {
  const ran = useRef(false);
  const claimByKey = trpc.merch.claimByKey.useMutation();

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    claimByKey.mutate({ key: orderKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  if (!claimByKey.data && !claimByKey.error)
    return (
      <Center>
        <Loader />
      </Center>
    );
  if (claimByKey.error)
    return (
      <Alert color="red" title="Couldn't claim">
        {claimByKey.error.message}
      </Alert>
    );
  return <GrantedMessage buzz={claimByKey.data?.grantedBuzz ?? 0} />;
}

export default function MerchClaimPage() {
  const router = useRouter();
  const orderKey = typeof router.query.key === 'string' ? router.query.key : undefined;

  if (orderKey)
    return (
      <Wrapper>
        <KeyFlow orderKey={orderKey} />
      </Wrapper>
    );

  return (
    <Wrapper>
      <Alert color="yellow" title="No claim link">
        Open the claim link from your Civitai merch reward email to add your Buzz.
      </Alert>
    </Wrapper>
  );
}
