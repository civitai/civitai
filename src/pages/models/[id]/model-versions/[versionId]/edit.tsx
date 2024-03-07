import { Anchor, Button, Container, Group, Stack, Text, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export default function ModelVersionEditPage() {
  const router = useRouter();
  const modelId = Number(router.query.id);
  const modelVersionId = Number(router.query.versionId);
  const currentUser = useCurrentUser();
  const {
    data: modelVersion,
    isLoading,
    isError,
  } = trpc.modelVersion.getById.useQuery({
    id: modelVersionId,
  });

  const isModerator = currentUser?.isModerator ?? false;
  const isOwner = modelVersion?.model?.user.id === currentUser?.id || isModerator;

  if (isLoading) return <PageLoader />;
  if (!modelVersion || isError || (!isOwner && !isModerator)) return <NotFound />;

  const handleClose = () => {
    router.push(`/models/${modelId}?modelVersionId=${modelVersionId}`);
  };

  return (
    <Container size="sm">
      <Stack spacing="xl">
        <Link href={`/models/${modelVersion?.model.id}`} passHref shallow>
          <Anchor size="xs">
            <Group spacing={4}>
              <IconArrowLeft size={18} strokeWidth={1.5} />
              <Text inherit>Back to {modelVersion?.model?.name} page</Text>
            </Group>
          </Anchor>
        </Link>
        <Title order={1}>Edit Version</Title>
        <ModelVersionUpsertForm
          model={modelVersion?.model}
          version={modelVersion}
          onSubmit={handleClose}
        >
          {({ loading }) => (
            <Group mt="xl" position="right">
              <Button variant="default" onClick={handleClose}>
                Cancel
              </Button>
              <Button type="submit" loading={loading}>
                Save
              </Button>
            </Group>
          )}
        </ModelVersionUpsertForm>
      </Stack>
    </Container>
  );
}
