import { Container } from '@mantine/core';
import { Bugs } from '~/components/Bug/Bugs';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.bug.getInfinite.prefetch({});
  },
});

export default function Page() {
  return (
    <>
      <Meta
        title="Known Issues | Civitai"
        description="Track open issues we're aware of and let us know if you're experiencing them."
        canonical="/issues"
      />
      <Container size="lg" p="md" my="xl">
        <Bugs />
      </Container>
    </>
  );
}
