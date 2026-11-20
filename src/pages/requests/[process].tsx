import { Container, Loader, Stack, Text, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import { Meta } from '~/components/Meta/Meta';
import { NotFound } from '~/components/AppLayout/NotFound';
import { RequestForm } from '~/components/TakedownRequests/RequestForm';
import { trpc } from '~/utils/trpc';

export default function RequestProcessPage() {
  const { query } = useRouter();
  const { data: forms, isLoading } = trpc.takedownRequest.forms.useQuery();
  const form = forms?.find((f) => f.key === query.process);
  if (isLoading) return <Loader />;
  if (!form) return <NotFound />;
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
