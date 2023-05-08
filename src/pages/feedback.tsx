import { env } from '~/env/client.mjs';
import { CannyBoard } from '~/components/Canny/CannyBoard';
import { Container } from '@mantine/core';

export default function Feedback() {
  return (
    <Container size="xl">
      <CannyBoard boardToken={env.NEXT_PUBLIC_CANNY_FEEDBACK_BOARD} basePath="/feedback" />
    </Container>
  );
}
