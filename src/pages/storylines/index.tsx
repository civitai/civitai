import { Group, Stack, Title } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { StartStorylineButton } from '~/components/Storyline/StartStorylineButton';
import { StorylinesFeed } from '~/components/Storyline/StorylinesFeed';
import { StorylinesIntro } from '~/components/Storyline/StorylinesIntro';
import { STORYLINES_URL } from '~/components/Storyline/storyline-routes';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.storylines) return { notFound: true };
  },
});

function StorylinesPage() {
  return (
    <>
      <Meta title="Storylines" canonical={STORYLINES_URL} />
      <MasonryContainer>
        <Stack gap="md">
          <Group justify="space-between" wrap="nowrap">
            <Title order={1}>Storylines</Title>
            <StartStorylineButton />
          </Group>
          <StorylinesIntro />
          <StorylinesFeed />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(StorylinesPage, { InnerLayout: FeedLayout });
