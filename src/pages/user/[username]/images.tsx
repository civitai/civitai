import { useRouter } from 'next/router';

import { Container, Group, Stack } from '@mantine/core';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ImageCategories } from '~/components/Image/Infinite/ImageCategories';

export default function UserImages() {
  const router = useRouter();
  const username = router.query.username as string;

  return (
    <Container fluid style={{ maxWidth: 2500 }}>
      <Stack spacing="xs">
        <Group position="apart" spacing={0}>
          <SortFilter type="image" />
          <PeriodFilter />
        </Group>
        <ImageCategories />
        <ImagesInfinite username={username} withTags />
      </Stack>
    </Container>
  );
}
