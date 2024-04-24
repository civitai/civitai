import {
  Alert,
  Button,
  Card,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { CosmeticSource } from '@prisma/client';
import { IconCircleCheck, IconClock2, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useQueryCosmetic } from '~/components/Cosmetics/cosmetics.util';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { enterFall, jelloVertical } from '~/libs/animations';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { numericString } from '~/utils/zod-helpers';

const querySchema = z.object({ id: numericString() });

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
    if (ssg) await ssg.cosmetic.getById.prefetch({ id });
    return { props: { id } };
  },
});

const availableCosmeticTypes: string[] = ['Badge', 'ContentDecoration'];
type ClaimStatus = 'unavailable' | 'pending' | 'claimed' | 'equipped';
export default function ClaimCosmeticPage({ id }: { id: number }) {
  const queryUtils = trpc.useContext();
  const [status, setStatus] = useState<ClaimStatus | null>();
  const { cosmetic, isLoading: cosmeticLoading } = useQueryCosmetic({ id });
  const { data: cosmeticStatus, refetch } = trpc.user.cosmeticStatus.useQuery({ id });

  useEffect(() => {
    if (!cosmeticStatus) return;

    setStatus(
      !cosmeticStatus.available
        ? 'unavailable'
        : cosmeticStatus.equipped
        ? 'equipped'
        : cosmeticStatus.obtained
        ? 'claimed'
        : 'pending'
    );
  }, [cosmeticStatus]);

  const claimComesticMutation = trpc.user.claimCosmetic.useMutation({
    onSuccess: async () => {
      setStatus('claimed');
      await queryUtils.user.getById.invalidate();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to claim cosmetic',
        error: new Error(error.message),
      });
    },
  });
  const equipCosmeticMutation = trpc.user.equipCosmetic.useMutation({
    onSuccess: async () => {
      setTimeout(() => refetch(), 2000);
    },
  });

  const handleClaim = () => {
    claimComesticMutation.mutate({ id });
  };

  const handleEquip = () => {
    equipCosmeticMutation.mutate({ id });
    setStatus('equipped');
  };

  if (cosmeticLoading || !cosmetic) return <PageLoader />;
  const canClaim =
    availableCosmeticTypes.includes(cosmetic.type) && cosmetic.source === CosmeticSource.Claim;
  if (!canClaim) {
    return <NotFound />;
  }

  const cosmeticAvailable =
    (!cosmetic.availableStart || cosmetic.availableStart < new Date()) &&
    (!cosmetic.availableEnd || cosmetic.availableEnd > new Date());
  const cosmeticImage = (cosmetic.data as MixedObject).url;

  const actionStates: Record<ClaimStatus, React.ReactNode> = {
    unavailable: (
      <Alert radius="sm" color="red" sx={{ zIndex: 10 }}>
        <Group spacing="xs" noWrap position="center">
          <ThemeIcon color="red" size="lg">
            <IconX strokeWidth={3} />
          </ThemeIcon>
          <Title order={2}>{`You haven't earned this cosmetic`}</Title>
        </Group>
      </Alert>
    ),
    pending: (
      <Center>
        <Button onClick={handleClaim} size="lg" w={300}>
          Claim
        </Button>
      </Center>
    ),
    claimed: (
      <Button onClick={handleEquip} color="green" size="lg" w={300}>
        Equip
      </Button>
    ),
    equipped: (
      <Alert radius="sm" color="green" sx={{ zIndex: 10 }}>
        <Group spacing="xs" noWrap position="center">
          <ThemeIcon color="green" size="lg">
            <IconCircleCheck />
          </ThemeIcon>
          <Title order={2}>{`This cosmetic is equipped`}</Title>
        </Group>
      </Alert>
    ),
  };

  return (
    <>
      <Meta
        title={`Claim ${cosmetic.name} | Civitai`}
        description={`Claim the ${cosmetic.name}. Awarded for ${cosmetic.description} while you can`}
        imageUrl={getEdgeUrl(cosmeticImage, { width: 256 })}
      />
      <Container size="xs" mb="lg">
        <Stack spacing={0}>
          {cosmeticAvailable && status !== 'unavailable' && (
            <Center>
              <Alert radius="sm" color="blue" sx={{ zIndex: 10 }}>
                <Group spacing="xs" noWrap position="center">
                  <Text size="md" weight={500}>{`🎉 You've received a cosmetic! 🎉`}</Text>
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
            h={256}
            my="lg"
          >
            {cosmetic.type === 'Badge' && (
              <EdgeMedia
                src={(cosmetic.data as MixedObject).url}
                width="original"
                alt={cosmetic.name}
                style={{ height: 256, width: 256 }}
              />
            )}
            {cosmetic.type === 'ContentDecoration' && (
              <Card
                withBorder
                shadow="sm"
                h={256}
                w={(256 * 2) / 3}
                sx={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
              >
                <Text size="xs" color="dimmed">
                  Example Cosmetic here
                </Text>
              </Card>
            )}
          </Center>
          <Title order={1} align="center" mb={5}>
            {cosmetic.name}
          </Title>
          <Text size="lg" align="center">
            {cosmetic.description}
          </Text>

          <Center mt="xl">
            {!cosmeticAvailable ? (
              <Alert radius="sm" color="red" sx={{ zIndex: 10 }}>
                <Group spacing="xs" noWrap position="center">
                  <Text size="lg">🥲 This cosmetic is no longer available to claim</Text>
                </Group>
              </Alert>
            ) : status ? (
              actionStates[status]
            ) : (
              <Loader />
            )}
          </Center>
        </Stack>
      </Container>
    </>
  );
}
