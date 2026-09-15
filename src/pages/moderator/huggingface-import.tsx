import { Container, Stack, Text, Title } from '@mantine/core';
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
      <Container size="lg" py="lg">
        <Stack gap="xl">
          <Stack gap={4}>
            <Title order={2}>Hugging Face Import</Title>
            <Text c="dimmed" size="sm">
              Queue model files for transfer from Hugging Face into our storage. A cron job moves
              them a part at a time, so a transfer survives a deploy and resumes where it stopped.
            </Text>
          </Stack>

          <RepoLookupSection />
          <ImportQueueTable />
          <ImportConfigSection />
        </Stack>
      </Container>
    </>
  );
}

export default Page(HuggingFaceImportPage);
