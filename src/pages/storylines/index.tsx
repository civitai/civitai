import { ActionIcon, Group, Stack, Title, Tooltip } from '@mantine/core';
import { IconHelp } from '@tabler/icons-react';
import { useState } from 'react';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { StartStorylineButton } from '~/components/Storyline/StartStorylineButton';
import type { StorylineFeedFilter } from '~/components/Storyline/StorylineFiltersDropdown';
import type { StorylineFeedSort } from '~/components/Storyline/StorylinesFeed';
import { StorylinesFeed, StorylinesFeedControls } from '~/components/Storyline/StorylinesFeed';
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
  const [filter, setFilter] = useState<StorylineFeedFilter>('all');
  const [sort, setSort] = useState<StorylineFeedSort>('newest');
  const [introDismissed, dismissIntro, restoreIntro] = useIntroDismissed(
    STORYLINES_INTRO_DISMISSED_KEY
  );

  return (
    <>
      <Meta title="Storylines" canonical={STORYLINES_URL} />
      <MasonryContainer>
        <Stack gap="md">
          {/* On a phone the menus take their own row under the title and the button. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Group gap={4} wrap="nowrap" className="order-1">
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
            <div className="order-3 w-full sm:order-2 sm:w-auto">
              <StorylinesFeedControls
                sort={sort}
                onSort={setSort}
                filter={filter}
                onFilter={setFilter}
              />
            </div>
            <StartStorylineButton className="order-2 ml-auto sm:order-3" />
          </div>
          <StorylinesIntro dismissed={introDismissed} onDismiss={dismissIntro} />
          <StorylinesFeed filter={filter} sort={sort} />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(StorylinesPage, { InnerLayout: FeedLayout });
