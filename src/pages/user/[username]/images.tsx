import { useRouter } from 'next/router';

import { Container } from '@mantine/core';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';

export default function UserImages() {
  const router = useRouter();
  const username = router.query.username as string;

  return (
    <Container fluid style={{ maxWidth: 2500 }}>
      <ImagesInfinite username={username} withTags />
    </Container>
  );
}
