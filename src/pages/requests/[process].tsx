import { Anchor, Container, Loader, Stack, Text, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import { Meta } from '~/components/Meta/Meta';
import { NotFound } from '~/components/AppLayout/NotFound';
import { fallbackMailbox } from '~/components/TakedownRequests/fallback-mailbox';
import { RequestForm } from '~/components/TakedownRequests/RequestForm';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export default function RequestProcessPage() {
  const features = useFeatureFlags();
  const { query } = useRouter();
  const {
    data: forms,
    isLoading,
    isError,
  } = trpc.takedownRequest.forms.useQuery(undefined, {
    enabled: !!features.takedownRequests,
  });
  const form = forms?.find((f) => f.key === query.process);
  if (!features.takedownRequests) return <NotFound />;
  if (isLoading) return <Loader />;
  if (!form) {
    // An outage or an unconfigured deployment is not a missing form: say where to write instead.
    if (isError || !forms?.length) return <Unavailable processKey={String(query.process ?? '')} />;
    return <NotFound />;
  }
  return (
    <>
      <Meta title={`${form.title} | Civitai`} deIndex />
      <Container size="sm" py="xl">
        <Stack gap="lg">
          <Title order={1}>{form.title}</Title>
          <Text c="dimmed">Fields marked * are required.</Text>
          <RequestForm form={form} />
        </Stack>
      </Container>
    </>
  );
}

function Unavailable({ processKey }: { processKey: string }) {
  const mailbox = fallbackMailbox(processKey);
  return (
    <Container size="sm" py="xl">
      <Text>
        This form is unavailable right now. Email{' '}
        <Anchor href={`mailto:${mailbox}`}>{mailbox}</Anchor>.
      </Text>
    </Container>
  );
}
