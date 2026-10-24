import { Container } from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { MysteryBoxOddsPage } from '~/components/MysteryBox/MysteryBoxOddsPage';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { INT4_MAX } from '~/server/schema/base.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

const paramsSchema = z.object({ id: z.coerce.number().int().positive().max(INT4_MAX) });

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  // 'always': notFound, and any redirect, is decided from prefetched data, so a client navigation
  // must prefetch too.
  prefetch: 'always',
  resolver: async ({ ctx, ssg }) => {
    const parsed = paramsSchema.safeParse(ctx.params);
    if (!parsed.success) return { notFound: true };
    const boxDefinitionId = parsed.data.id;
    if (ssg) {
      const page = await ssg.mysteryBox.getOddsPage
        .fetch({ boxDefinitionId })
        .catch(() => undefined);
      if (page === null) return { notFound: true };
    }
    return { props: { boxDefinitionId } };
  },
});

export default function MysteryBoxOddsRoute({
  boxDefinitionId,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const { data: page, isLoading } = trpc.mysteryBox.getOddsPage.useQuery({ boxDefinitionId });
  const team = typeof router.query.team === 'string' ? router.query.team : undefined;

  if (isLoading) return <PageLoader />;
  if (!page) return <NotFound />;

  return (
    <>
      <Meta
        title={`${page.name} odds and contents | Civitai`}
        description={`The odds, full contents and change history of ${page.name}.`}
        canonical={`/mystery-boxes/${boxDefinitionId}`}
      />
      <Container size="md" my="xl">
        <MysteryBoxOddsPage
          page={page}
          team={team}
          onTeamChange={(next) =>
            router.replace(
              { pathname: router.pathname, query: { ...router.query, team: next } },
              undefined,
              {
                shallow: true,
                scroll: false,
              }
            )
          }
        />
      </Container>
    </>
  );
}
