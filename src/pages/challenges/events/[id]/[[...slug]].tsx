import { Stack, Title, Text, Button } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { ChallengesInfinite } from '~/components/Challenge/Infinite/ChallengesInfinite';
import { EventBannerCard } from '~/components/Challenge/EventBannerCard';
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
          <Button
            component={Link}
            href="/challenges"
            variant="subtle"
            size="compact-sm"
            leftSection={<IconArrowLeft size={16} />}
            className="self-start"
          >
            All Challenges
          </Button>
          {event && (
            <EventBannerCard event={event} linkable={false} count={event.challengeCount} />
          )}
          {event?.description && <Text c="dimmed">{event.description}</Text>}
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
