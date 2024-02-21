import { Container } from '@mantine/core';
import { RunPartners } from '~/components/RunStrategy/RunPartners';

export default function Demo() {
  return (
    <Container size="xs">
      <RunPartners modelVersionId={1144} />
    </Container>
  );
}
