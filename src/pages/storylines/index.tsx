import { ActionIcon, Group, Stack, Title, Tooltip } from '@mantine/core';
import { IconHelp } from '@tabler/icons-react';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { StartStorylineButton } from '~/components/Storyline/StartStorylineButton';
import { useStorylineFeedParams } from '~/components/Storyline/StorylineFeedFilters';
import { StorylinesFeed } from '~/components/Storyline/StorylinesFeed';
import {
  STORYLINES_INTRO_DISMISSED_KEY,
  StorylinesIntro,
} from '~/components/Storyline/StorylinesIntro';
import { STORYLINES_URL } from '~/components/Storyline/storyline-routes';
import { useIntroDismissed } from '~/hooks/useIntroDismissed';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.storylines) return { notFound: true };
  },
});

function StorylinesPage() {
  // Picked in the sub-nav (`StorylineFeedFilters`).
  const { filter, sort } = useStorylineFeedParams();
  const [introDismissed, dismissIntro, restoreIntro] = useIntroDismissed(
    STORYLINES_INTRO_DISMISSED_KEY
  );

  return (
    <>
      <Meta title="Storylines" canonical={STORYLINES_URL} />
      <MasonryContainer>
        <Stack gap="md">
          <Group gap="sm" wrap="nowrap" justify="space-between">
            <Group gap={4} wrap="nowrap">
              <Title order={1}>Storylines</Title>
              {introDismissed && (
                <Tooltip label="What are storylines?" withinPortal>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    radius="xl"
                    aria-label="What are storylines?"
                    onClick={restoreIntro}
                  >
                    <IconHelp size={20} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
            <StartStorylineButton />
          </Group>
          <StorylinesIntro dismissed={introDismissed} onDismiss={dismissIntro} />
          <StorylinesFeed filter={filter} sort={sort} />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(StorylinesPage, { InnerLayout: FeedLayout });
