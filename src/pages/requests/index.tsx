import { Anchor, Container, Loader, Stack, Text, Title } from '@mantine/core';
import Link from 'next/link';
import { Meta } from '~/components/Meta/Meta';
import { trpc } from '~/utils/trpc';

export default function RequestsPage() {
  const { data: forms, isLoading } = trpc.takedownRequest.forms.useQuery();
  return (
    <>
      <Meta title="Requests | Civitai" deIndex />
      <Container size="sm" py="xl">
        <Stack gap="lg">
          <Title order={1}>Requests</Title>
          <Text>Choose the request you want to make.</Text>
          {isLoading ? (
            <Loader />
          ) : forms?.length ? (
            <Stack gap="xs">
              {forms.map((f) => (
                <Anchor key={f.key} component={Link} href={`/requests/${f.key}`}>
                  {f.title}
                </Anchor>
              ))}
            </Stack>
          ) : (
            <Text>
              These forms are unavailable right now. Email{' '}
              <Anchor href="mailto:support@civitai.com">support@civitai.com</Anchor>.
            </Text>
          )}
        </Stack>
      </Container>
    </>
  );
}
