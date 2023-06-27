import { Container } from '@mantine/core';
import { AssociateModels } from '~/components/AssociatedModels/AssociateModels';
import { Generate } from '~/components/ImageGeneration/Generate';

export default function Test() {
  return (
    <Container size="xs">
      {/* <AssociateModels fromId={43331} type="Suggested" /> */}
      <Generate />
    </Container>
  );
}
