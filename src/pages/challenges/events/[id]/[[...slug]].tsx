import { Stack, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import { z } from 'zod';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { ChallengesInfinite } from '~/components/Challenge/Infinite/ChallengesInfinite';
import { EventHero } from '~/components/Challenge/EventHero';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { buildPassthroughQuery } from '~/utils/query-string-helpers';
import { slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const querySchema = z.object({
  id: z.coerce.number(),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg, features }) => {
    if (!features?.challengePlatform) return { notFound: true };

    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) {
      const event = await ssg.challenge.getEventById
        .fetch({ id: result.data.id })
        .catch(() => null);

      // Redirect to the canonical slug URL when it's missing or incorrect. Skip when the
      // canonical slug is empty (see the challenge detail page for the redirect-loop rationale).
      if (event) {
        const correctSlug = slugit(event.title);
        const currentSlug = result.data.slug?.join('/');
        if (correctSlug && currentSlug !== correctSlug) {
          const queryString = buildPassthroughQuery(ctx.query);
          return {
            redirect: {
              destination: `/challenges/events/${result.data.id}/${correctSlug}${queryString}`,
              permanent: false,
            },
          };
        }
      }
    }

    return { props: removeEmpty(result.data) };
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
        canonical={
          event ? `/challenges/events/${id}/${slugit(event.title)}` : `/challenges/events/${id}`
        }
      />
      <MasonryContainer>
        <Stack gap="lg">
          {event && <EventHero event={event} />}
          <Title order={2}>Challenges</Title>
          {!Number.isNaN(id) && (
            <ChallengesInfinite filters={{ challengeEventId: id, includeEnded: true }} />
          )}
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(ChallengeEventPage, { InnerLayout: FeedLayout, announcements: true });
