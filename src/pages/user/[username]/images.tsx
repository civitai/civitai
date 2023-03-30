import { Container, Group, Stack } from '@mantine/core';

import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ImageCategories } from '~/components/Image/Infinite/ImageCategories';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';

export default function UserImages() {
  return (
    <Container fluid style={{ maxWidth: 2500 }}>
      <Stack spacing="xs">
        <Group position="apart" spacing={0}>
          <SortFilter type="image" />
          <PeriodFilter />
        </Group>
        <ImageCategories />
        <ImagesInfinite />
      </Stack>
    </Container>
  );
}
