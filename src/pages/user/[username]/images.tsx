import { useRouter } from 'next/router';

import { Container, Group } from '@mantine/core';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { PeriodFilter, SortFilter } from '~/components/Filters';

export default function UserImages() {
  const router = useRouter();
  const username = router.query.username as string;

  return (
    <Container fluid style={{ maxWidth: 2500 }}>
      <Group position="apart" spacing={0}>
        <SortFilter type="image" />
        <PeriodFilter />
      </Group>
      <ImagesInfinite username={username} withTags />
    </Container>
  );
}
