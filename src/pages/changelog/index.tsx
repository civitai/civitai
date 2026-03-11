import { Container } from '@mantine/core';
import { Changelogs } from '~/components/Changelog/Changelogs';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.changelog.getAllTags.prefetch();
  },
});

export default function Page() {
  return (
    <>
      <Meta
        title="Civitai Changelog | The latest updates to Civitai"
        description="List of the recent features, fixes, and improvements to Civitai."
        canonical="/changelog"
      />
      <Container size="lg" p="md" my="xl">
        <Changelogs />
      </Container>
    </>
  );
}
