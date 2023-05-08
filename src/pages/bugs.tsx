import { env } from '~/env/client.mjs';
import { CannyBoard } from '~/components/Canny/CannyBoard';
import { Container } from '@mantine/core';

export default function Bugs() {
  return (
    <Container size="xl">
      <CannyBoard boardToken={env.NEXT_PUBLIC_CANNY_BUG_BOARD} basePath="/bugs" />
    </Container>
  );
}
