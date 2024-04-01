import {
  Alert,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons-react';
import { z } from 'zod';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { enterFall, jelloVertical } from '~/libs/animations';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const querySchema = z.object({ id: z.string() });

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ session, ctx, ssg }) => {
    if (!session) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'perform-action' }),
          permanent: false,
        },
      };
    }

    const queryParse = querySchema.safeParse(ctx.query);
    if (!queryParse.success) return { notFound: true };

    const id = queryParse.data?.id;
    if (ssg) await ssg.buzz.getClaimStatus.prefetch({ id });
    return { props: { id } };
  },
});

export default function ClaimBuzzPage({ id }: { id: string }) {
  const queryUtils = trpc.useContext();

  const { data: claim, isLoading: claimLoading } = trpc.buzz.getClaimStatus.useQuery({
    id,
  });

  const claimMutation = trpc.buzz.claim.useMutation({
    onSuccess: async (result) => {
      await queryUtils.buzz.getClaimStatus.setData({ id }, result);
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to claim buzz',
        error: new Error(error.message),
      });
    },
  });

  const handleClaim = () => claimMutation.mutate({ id });

  if (claimLoading || !claim) return <PageLoader />;

  return (
    <>
      <Meta title={`Claim Buzz | Civitai`} />
      <Container size="xs" mb="lg">
        <Stack spacing={0}>
          {claim.status !== 'unavailable' && (
            <Center>
              <Alert radius="sm" color="blue" sx={{ zIndex: 10 }}>
                <Group spacing="xs" noWrap position="center">
                  <Text size="md" weight={500}>{`🎉 You've received a Buzz Reward! 🎉`}</Text>
                </Group>
              </Alert>
            </Center>
          )}
          <Center
            sx={{
              animationName: `${enterFall}, ${jelloVertical}`,
              animationDuration: `1.5s, 2s`,
              animationDelay: `0s, 1.5s`,
              animationIterationCount: '1, 1',
            }}
            h={120}
            my="lg"
          >
            <Text size={64} weight={500} ml={-30}>
              ⚡{claim.details.amount}
            </Text>
          </Center>
          <Title order={1} align="center" mb={5}>
            {claim.details.title}
          </Title>
          <Text size="lg" align="center">
            {claim.details.description}
          </Text>

          <Center mt="xl">
            {claim.status === 'unavailable' ? (
              <Alert radius="sm" color="red" sx={{ zIndex: 10 }}>
                <Group spacing="xs" noWrap position="center">
                  <Text size="lg">🥲 {claim.reason}</Text>
                </Group>
              </Alert>
            ) : claim.status === 'available' ? (
              <Center>
                <Button onClick={handleClaim} size="lg" w={300}>
                  Claim
                </Button>
              </Center>
            ) : claim.status === 'claimed' ? (
              <Alert radius="sm" color="green" sx={{ zIndex: 10 }}>
                <Group spacing="xs" noWrap position="center">
                  <ThemeIcon color="green" size="lg">
                    <IconCircleCheck />
                  </ThemeIcon>
                  <Title order={2}>{`You've claimed this reward!`}</Title>
                </Group>
              </Alert>
            ) : (
              <Loader />
            )}
          </Center>
        </Stack>
      </Container>
    </>
  );
}
