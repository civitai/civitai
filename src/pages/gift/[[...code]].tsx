import { Button, Center, Container, Stack, Text, TextInput, ThemeIcon, Title } from '@mantine/core';
import { IconGift } from '@tabler/icons-react';
import { useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

const GIFT_CODE_COOKIE = 'civ-gift-code';

// A code arriving in the path moves into a short-lived, server-only cookie and the URL becomes a bare
// /gift: analytics and RUM scripts record the page URL, and the code is a live credential.
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.modelGiftLinks) return { notFound: true };
    const segment = ctx.params?.code;
    const fromPath = Array.isArray(segment) ? segment[0] : undefined;
    if (fromPath) {
      ctx.res.setHeader(
        'Set-Cookie',
        `${GIFT_CODE_COOKIE}=${encodeURIComponent(
          fromPath.slice(0, 64)
        )}; Path=/gift; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`
      );
      return { redirect: { destination: '/gift', permanent: false } };
    }
    if (!session)
      return { redirect: { destination: getLoginLink({ returnUrl: '/gift' }), permanent: false } };
    return { props: { initialCode: ctx.req.cookies[GIFT_CODE_COOKIE] ?? '' } };
  },
});

export default function GiftClaimPage({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const claim = trpc.modelVersionGift.claim.useMutation();
  const result = claim.data;

  return (
    <>
      <Meta title="Claim a gift | Civitai" deIndex />
      <Container size="xs" py="xl">
        <Center>
          <Stack align="center" gap="md" w="100%">
            <ThemeIcon size={64} radius="xl" variant="light">
              <IconGift size={36} />
            </ThemeIcon>
            <Title order={2}>Claim a gift</Title>
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
                  Claiming gives your account access to the model at no cost.
                </Text>
                <TextInput
                  w="100%"
                  label="Gift code"
                  placeholder="cvg_…"
                  value={code}
                  onChange={(e) => setCode(e.currentTarget.value)}
                />
                {claim.error && (
                  <Text c="red" ta="center">
                    {claim.error.message}
                  </Text>
                )}
                <Button
                  loading={claim.isPending}
                  disabled={!code.trim()}
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
