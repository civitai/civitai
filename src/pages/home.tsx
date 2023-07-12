import { Container, Title } from '@mantine/core';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';

export default function Home() {
  return (
    <Container size="xl">
      <Title order={1}>Home</Title>
      <HomeContentToggle />
    </Container>
  );
}
