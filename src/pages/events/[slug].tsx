import { Alert, Button, Container, Stack, Title } from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useMutateEvent, useQueryEvent } from '~/components/Events/events.utils';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { env } from '~/env/client.mjs';
import { eventSchema } from '~/server/schema/event.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { showErrorNotification } from '~/utils/notifications';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const result = eventSchema.safeParse({ event: ctx.query.slug });
    if (!result.success) return { notFound: true };

    const { event } = result.data;
    if (ssg) {
      await ssg.event.getTeamScores.prefetch({ event });
      await ssg.event.getCosmetic.prefetch({ event });
    }

    return { props: { event } };
  },
});

export default function EventPageDetails({
  event,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { teamScores, eventCosmetic, loading } = useQueryEvent({ event });
  const { activateCosmetic, donate, equipping } = useMutateEvent();

  if (loading) return <PageLoader />;
  if (!eventCosmetic) return <NotFound />;

  const handleEquipCosmetic = async () => {
    try {
      await activateCosmetic({ event });
    } catch (e) {
      const error = e as Error;
      showErrorNotification({ title: 'Unable to equip cosmetic', error });
    }
  };

  return (
    <>
      <Meta
        title={`${eventCosmetic.cosmetic?.name} | Civitai`}
        description={eventCosmetic.cosmetic?.description ?? undefined}
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/events/${event}`, rel: 'canonical' }]}
      />
      <Container size="sm">
        <Stack>
          <Title>Event Page</Title>
          {eventCosmetic.available && !eventCosmetic.equipped ? (
            <Button onClick={handleEquipCosmetic} loading={equipping}>
              Equip cosmetic
            </Button>
          ) : eventCosmetic.equipped ? (
            <Alert color="green">This cosmetic is equipped</Alert>
          ) : (
            <Alert color="red">This cosmetic is not available</Alert>
          )}
        </Stack>
      </Container>
    </>
  );
}
