import { Container, Stack, Text, Title } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';

export function NotFound() {
  return (
    <>
      <Meta title="Page Not Found" />

      <Container size="xl" p="xl">
        <Stack align="center">
          <Title order={1}>404</Title>
          <Text size="xl">The page you are looking for doesn&apos;t exists</Text>
        </Stack>
      </Container>
    </>
  );
}
