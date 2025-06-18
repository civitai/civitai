import { Anchor, Button, Container, Group, Stack, Text, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { ReadOnlyAlert } from '~/components/ReadOnlyAlert/ReadOnlyAlert';

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
      <Stack gap="xl">
        <ReadOnlyAlert
          message={
            "Civitai is currently in read-only mode and you won't be able to edit your model version. Please try again later."
          }
        />
        <Link legacyBehavior href={`/models/${modelVersion?.model.id}`} passHref shallow>
          <Anchor size="xs">
            <Group gap={4}>
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
          {({ loading, canSave }) => (
            <Group mt="xl" justify="flex-end">
              <Button variant="default" onClick={handleClose}>
                Cancel
              </Button>
              <Button type="submit" loading={loading} disabled={!canSave}>
                Save
              </Button>
            </Group>
          )}
        </ModelVersionUpsertForm>
      </Stack>
    </Container>
  );
}
