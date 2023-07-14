import { Container } from '@mantine/core';
import { Generate } from '~/components/ImageGeneration/Generate';

export default function Test() {
  return (
    <Container size="xs">
      {/* <AssociateModels fromId={43331} type="Suggested" /> */}
      <Generate />
    </Container>
  );
}
