import { Container } from '@mantine/core';
import { Generate2 } from '~/components/ImageGeneration/Generate2';

export default function Test() {
  return (
    <Container size="xs">
      {/* <AssociateModels fromId={43331} type="Suggested" /> */}
      <Generate2 />
    </Container>
  );
}
