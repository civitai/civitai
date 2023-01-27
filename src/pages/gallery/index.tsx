import { Container, Center, Paper, Title } from '@mantine/core';
import { useGalleryFilters } from '~/components/Gallery/GalleryFilters';
import { trpc } from '~/utils/trpc';

export default function Gallery() {
  const filters = useGalleryFilters();

  const { data, isLoading } = trpc.image.getGalleryImagesInfinite.useInfiniteQuery(filters);

  return (
    <Container>
      <Center py="xl">
        <Paper>
          <Title>Coming Soon!</Title>
        </Paper>
      </Center>
    </Container>
  );
}
