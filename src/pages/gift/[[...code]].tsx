import { Button, Center, Container, Stack, Text, TextInput, ThemeIcon, Title } from '@mantine/core';
import { IconGift } from '@tabler/icons-react';
import { useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { resolveGiftClaimPage } from '~/server/utils/gift-claim-page';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => resolveGiftClaimPage({ features, session, ctx }),
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
                  Claiming gives your account access to the model at no cost. The creator can see
                  that you claimed this, and can remove gifted access.
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
