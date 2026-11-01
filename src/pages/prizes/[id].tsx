import { Anchor, Container, Stack } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import * as z from 'zod';
import { Meta } from '~/components/Meta/Meta';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PrizeClaimCard } from '~/components/Prize/PrizeClaimCard';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

const querySchema = z.object({ id: z.coerce.number().int().positive() });

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'perform-action' }),
          permanent: false,
        },
      };

    const parsed = querySchema.safeParse(ctx.query);
    if (!parsed.success) return { notFound: true };
    return { props: { id: parsed.data.id } };
  },
});

export default function PrizeClaimPage({ id }: { id: number }) {
  const { data: prize, isLoading } = trpc.prize.getById.useQuery({ id });

  if (isLoading) return <PageLoader />;
  if (!prize) return <NotFound />;

  return (
    <>
      <Meta title="Claim your prize | Civitai" deIndex />
      <Container size="xs" my="xl">
        <Stack gap="md">
          <PrizeClaimCard prize={prize} />
          <Anchor component={Link} href="/prizes" ta="center" size="sm">
            View all your prizes
          </Anchor>
        </Stack>
      </Container>
    </>
  );
}
