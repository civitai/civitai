import { Container, Stack, Text, Title } from '@mantine/core';
import Head from 'next/head';

export function NotFound() {
  return (
    <>
      <Head>
        <meta name="title" content="404 Page Not Found" />
      </Head>
      <Container size="xl" p="xl">
        <Stack align="center">
          <Title order={1}>404</Title>
          <Text size="xl">The page you are looking for doesn&apos;t exists</Text>
        </Stack>
      </Container>
    </>
  );
}
