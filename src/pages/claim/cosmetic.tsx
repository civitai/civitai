import { Button, Container, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { z } from 'zod';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { numericString } from '~/utils/zod-helpers';

const querySchema = z.object({ id: numericString() });

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'perform-action' }),
          permanent: false,
        },
      };
    }

    if (session.user?.muted) return { notFound: true };

    const queryParse = querySchema.safeParse(ctx.query);
    if (queryParse.success) return { props: { id: queryParse.data.id } };
  },
});

export default function ClaimCosmeticPage({ id }: { id?: number }) {
  const queryUtils = trpc.useContext();
  const [alreadyClaimed, setAlreadyClaimed] = useState(false);
  const [claimed, setClaimed] = useState(false);

  const claimComesticMutation = trpc.user.claimCosmetic.useMutation({
    onSuccess: async () => {
      setClaimed(true);
      await queryUtils.user.getById.invalidate();
    },
    onError: (error) => {
      if (error.data?.code === 'CONFLICT') setAlreadyClaimed(true);
      else
        showErrorNotification({
          title: 'Unable to claim cosmetic',
          error: new Error(error.message),
        });
    },
  });

  const handleClaim = () => {
    if (!id) return;
    claimComesticMutation.mutate({ id });
  };

  return (
    <Container size="xs">
      <Stack>
        <Title>Thank you for being part of our community!</Title>
        <Text>We have a small gift for you, please click the button below to claim it.</Text>
        {claimed ? (
          <Text>Check your account for a surprise!</Text>
        ) : alreadyClaimed ? (
          <Text>You have previously claimed this cosmetic. Thank you!</Text>
        ) : (
          <Button
            size="lg"
            onClick={handleClaim}
            loading={claimComesticMutation.isLoading}
            fullWidth
          >
            Claim your gift 🎉
          </Button>
        )}
      </Stack>
    </Container>
  );
}
