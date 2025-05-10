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
  useMantineTheme,
} from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons-react';
import { z } from 'zod';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { CurrencyConfig } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Currency } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
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
  const queryUtils = trpc.useUtils();
  const features = useFeatureFlags();
  const { multipliers, multipliersLoading } = useUserMultipliers();
  const { data: claim, isLoading: claimLoading } = trpc.buzz.getClaimStatus.useQuery(
    { id },
    { enabled: features.buzz }
  );
  const mantineTheme = useMantineTheme();
  const config = CurrencyConfig[Currency.BUZZ];
  const theme = config?.themes?.[claim?.details?.accountType ?? ''] ?? config;
  const color = theme.color(mantineTheme);
  const Icon = theme.icon;
  // const color = claim.accountType === 'generation' ? config.

  const claimMutation = trpc.buzz.claim.useMutation({
    onSuccess: async (result) => {
      await queryUtils.buzz.getClaimStatus.setData({ id }, result);
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to claim Buzz',
        error: new Error(error.message),
      });
    },
  });

  const handleClaim = () => claimMutation.mutate({ id });

  if (claimLoading || !claim || multipliersLoading) return <PageLoader />;

  const { rewardsMultiplier = 1 } = multipliers ?? {};
  const finalAmount = claim.details.useMultiplier
    ? Math.ceil(claim.details.amount * rewardsMultiplier)
    : claim.details.amount;

  return (
    <>
      <Meta title={`Claim Buzz | Civitai`} deIndex />
      <Container size="xs" mb="lg">
        <Stack gap={0}>
          {claim.status !== 'unavailable' && (
            <Center>
              <Alert radius="sm" color="blue" sx={{ zIndex: 10 }}>
                <Group gap="xs" wrap="nowrap" justify="center">
                  <Text size="md" weight={500}>{`🎉 You've received a Buzz Reward! 🎉`}</Text>
                </Group>
              </Alert>
            </Center>
          )}
          <Center
            sx={{
              animationName: `enterFall, jelloVertical`,
              animationDuration: `1.5s, 2s`,
              animationDelay: `0s, 1.5s`,
              animationIterationCount: '1, 1',
            }}
            h={120}
            my="lg"
          >
            <Stack gap={0}>
              <Text size={64} weight={500} ml={-30} color={color} component="span">
                <Icon
                  color={color}
                  fill={color}
                  style={{ fill: color, display: 'inline' }}
                  size={52}
                />
                {numberWithCommas(finalAmount)}
              </Text>

              {claim.details.useMultiplier && rewardsMultiplier > 1 && (
                <Text size="sm" color={color}>
                  Originally{' '}
                  <Text component="span" weight="bold">
                    {numberWithCommas(claim.details.amount)}{' '}
                  </Text>{' '}
                  Buzz
                </Text>
              )}
            </Stack>
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
                <Group gap="xs" wrap="nowrap" justify="center">
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
                <Group gap="xs" wrap="nowrap" justify="center">
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
