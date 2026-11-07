import { Button, Center, Container, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconGift } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.modelGiftLinks) return { notFound: true };
    // The code is the credential: keep it out of the Referer header sent to anything this page loads.
    ctx.res.setHeader('Referrer-Policy', 'no-referrer');
    if (!session)
      return {
        redirect: { destination: getLoginLink({ returnUrl: ctx.resolvedUrl }), permanent: false },
      };
  },
});

export default function GiftClaimPage() {
  const router = useRouter();
  const code = typeof router.query.code === 'string' ? router.query.code : '';
  const claim = trpc.modelVersionGift.claim.useMutation();
  const result = claim.data;

  return (
    <>
      <Meta title="Claim a gift | Civitai" deIndex />
      <Container size="xs" py="xl">
        <Center>
          <Stack align="center" gap="md">
            <ThemeIcon size={64} radius="xl" variant="light">
              <IconGift size={36} />
            </ThemeIcon>
            <Title order={2}>You&apos;ve been gifted a model</Title>
            {result ? (
              <>
                <Text ta="center">
                  {result.alreadyHadAccess
                    ? 'You already have access to this model.'
                    : 'The gift is yours. Enjoy the model.'}
                </Text>
                <Button
                  component={NextLink}
                  href={`/models/${result.modelId}?modelVersionId=${result.modelVersionId}`}
                >
                  Go to the model
                </Button>
              </>
            ) : (
              <>
                <Text ta="center" c="dimmed">
                  Claiming gives your account access to this model at no cost.
                </Text>
                {claim.error && (
                  <Text c="red" ta="center">
                    {claim.error.message}
                  </Text>
                )}
                <Button
                  loading={claim.isPending}
                  disabled={!code}
                  onClick={() => claim.mutate({ code })}
                >
                  Claim gift
                </Button>
              </>
            )}
          </Stack>
        </Center>
      </Container>
    </>
  );
}
