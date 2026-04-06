import { Stack, Title, Group, ThemeIcon, Text } from '@mantine/core';
import { IconTrophy } from '@tabler/icons-react';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { CompletedChallengesInfinite } from '~/components/Challenge/Infinite/CompletedChallengesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  resolver: async ({ features }) => {
    if (!features?.challengePlatform) return { notFound: true };
    return { props: {} };
  },
});

function PreviousWinnersPage() {
  return (
    <>
      <Meta
        title="Previous Challenge Winners | Civitai"
        description="Browse past AI art challenge winners and their prize-winning creations"
        canonical="/challenges/winners"
      />

      <MasonryContainer>
        <Stack gap="md">
          {/* Header */}
          <Group gap="sm">
            <ThemeIcon size="xl" radius="xl" color="yellow" variant="light">
              <IconTrophy size={24} />
            </ThemeIcon>
            <div>
              <Title order={1}>Previous Winners</Title>
              <Text c="dimmed" size="sm">
                Browse completed challenges and their winners
              </Text>
            </div>
          </Group>

          <CompletedChallengesInfinite />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(PreviousWinnersPage, { InnerLayout: FeedLayout, announcements: true });
