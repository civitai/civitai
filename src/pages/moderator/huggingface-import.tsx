import { Container, Grid, Stack, Text, Title } from '@mantine/core';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { ImportQueueTable } from '~/components/Moderation/HuggingFaceImport/ImportQueueTable';
import { ImportConfigSection } from '~/components/Moderation/HuggingFaceImport/ImportConfigSection';
import { RepoLookupSection } from '~/components/Moderation/HuggingFaceImport/RepoLookupSection';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({ requireModerator: true });

function HuggingFaceImportPage() {
  return (
    <>
      <Meta title="Hugging Face Import" deIndex />
      {/* The queue is a wide table of long filenames; a narrower container pushes its row actions
          into a horizontal scroll where nobody finds them. */}
      <Container size="xl" py="lg">
        <Stack gap="xl">
          <Stack gap={4}>
            <Title order={2}>Hugging Face Import</Title>
            <Text c="dimmed" size="sm">
              Queue model files for transfer from Hugging Face into our storage. A cron job moves
              them a part at a time, so a transfer survives a deploy and resumes where it stopped.
            </Text>
          </Stack>

          <Grid gutter="xl" align="flex-start">
            <Grid.Col span={{ base: 12, lg: 8.5 }}>
              <Stack gap="xl">
                <RepoLookupSection />
                <ImportQueueTable />
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, lg: 3.5 }}>
              <Stack gap="xl" pos="sticky" top={70}>
                <ImportConfigSection />
              </Stack>
            </Grid.Col>
          </Grid>
        </Stack>
      </Container>
    </>
  );
}

export default Page(HuggingFaceImportPage);
