import { Container } from '@mantine/core';
import { ImageSearchUpload } from '~/components/Search/ImageSearchUpload/ImageSearchUpload';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export default function SearchByImage() {
  return (
    <Container size="xl" py="md">
      <ImageSearchUpload />
    </Container>
  );
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session }) => {
    if (!session?.user || !features?.imageSearchUpload || !features?.moreLikeThis)
      return { notFound: true };
  },
});
