import { Anchor, Container, Loader, Stack, Text, Title } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { REQUESTS_MAILBOX } from '~/components/TakedownRequests/requests-mailbox';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export default function RequestsPage() {
  const features = useFeatureFlags();
  const { data: forms, isLoading } = trpc.takedownRequest.forms.useQuery(undefined, {
    enabled: !!features.takedownRequests,
  });
  if (!features.takedownRequests) return <NotFound />;
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
                <Anchor key={f.key} href={`/requests/${f.key}`}>
                  {f.title}
                </Anchor>
              ))}
            </Stack>
          ) : (
            <Text>
              These forms are unavailable right now. Email{' '}
              <Anchor href={`mailto:${REQUESTS_MAILBOX}`}>{REQUESTS_MAILBOX}</Anchor>.
            </Text>
          )}
        </Stack>
      </Container>
    </>
  );
}
