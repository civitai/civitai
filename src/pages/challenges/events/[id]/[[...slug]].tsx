import { Stack, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { ChallengesInfinite } from '~/components/Challenge/Infinite/ChallengesInfinite';
import { EventHero } from '~/components/Challenge/EventHero';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  resolver: async ({ features }) => {
    if (!features?.challengePlatform) return { notFound: true };
    return { props: {} };
  },
});

function ChallengeEventPage() {
  const router = useRouter();
  const id = Number(router.query.id);
  const { data: event, isLoading } = trpc.challenge.getEventById.useQuery(
    { id },
    { enabled: !Number.isNaN(id) }
  );

  if (!isLoading && !event) return <NotFound />;

  return (
    <>
      <Meta
        title={event ? `${event.title} | Civitai Challenges` : 'Challenge Event | Civitai'}
        description={event?.description ?? undefined}
        canonical={`/challenges/events/${id}`}
      />
      <MasonryContainer>
        <Stack gap="lg">
          {event && <EventHero event={event} />}
          <Title order={3}>Challenges</Title>
          {!Number.isNaN(id) && (
            <ChallengesInfinite filters={{ challengeEventId: id, includeEnded: true }} />
          )}
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(ChallengeEventPage, { InnerLayout: FeedLayout, announcements: true });
