import { Container } from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import { NotFound } from '~/components/AppLayout/NotFound';
import { TeamRoster } from '~/components/Events/ScoredEvent/TeamRoster';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { eventSchema } from '~/server/schema/event.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const result = eventSchema.safeParse({ event: ctx.query.slug });
    if (!result.success) return { notFound: true };
    const { event } = result.data;
    if (ssg) await ssg.event.getData.prefetch({ event }).catch(() => undefined);
    return { props: { event } };
  },
});

// A scored event's team rosters. Only events with a join have teams to list.
export default function EventTeamsPage({
  event,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.event.getData.useQuery({ event });
  const { data: cosmetic } = trpc.event.getCosmetic.useQuery({ event }, { enabled: !!currentUser });
  const ownTeam = cosmetic?.obtained
    ? (cosmetic.cosmetic?.data as { team?: string } | undefined)?.team
    : undefined;

  if (isLoading) return <PageLoader />;
  if (!data?.scored || !data.joinable) return <NotFound />;

  return (
    <>
      <Meta title={`Teams | ${data.title} | Civitai`} canonical={`/events/${event}/team`} />
      <Container size="lg" className="flex flex-col gap-4 py-6">
        <NextLink href={`/events/${event}`} className="text-sm">
          ← {data.title}
        </NextLink>
        <TeamRoster event={event} teams={data.teams} initialTeam={ownTeam} />
      </Container>
    </>
  );
}
