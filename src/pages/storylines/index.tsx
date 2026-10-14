import { Container, Text, Title } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';
import { StorylinesFeed } from '~/components/Storyline/StorylinesFeed';
import { STORYLINES_URL } from '~/components/Storyline/storyline-routes';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.storylines) return { notFound: true };
  },
});

export default function StorylinesRoute() {
  return (
    <>
      <Meta title="Storylines" canonical={STORYLINES_URL} />
      <Container size="xl" py="md" className="flex flex-col gap-4">
        <div>
          <Title order={1}>Storylines</Title>
          <Text c="dimmed">
            Stories told in posts, one chapter at a time. Pick one up from the start, or continue
            it.
          </Text>
        </div>
        <StorylinesFeed />
      </Container>
    </>
  );
}
