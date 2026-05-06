import {
  Anchor,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';

import { NotFound } from '~/components/AppLayout/NotFound';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Files } from '~/components/Resource/Files';
import { FilesProvider, useFilesContext } from '~/components/Resource/FilesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getModelUrl } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

function SaveButton() {
  const { startUpload, hasPending } = useFilesContext();

  if (!hasPending) return null;

  return (
    <Button
      onClick={async () => {
        await startUpload().catch(() => ({}));
      }}
    >
      Save Changes
    </Button>
  );
}

export default function FilesEditModal({ modelVersionId }: { modelVersionId: number }) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const { data: modelVersion, isLoading } = trpc.modelVersion.getByIdForEdit.useQuery({
    id: modelVersionId,
    withFiles: true,
  });

  const isModerator = currentUser?.isModerator ?? false;
  const isOwner = modelVersion?.model?.user.id === currentUser?.id || isModerator;
  if (!isLoading && modelVersion && !isOwner) dialog.onClose();

  return (
    <Modal {...dialog} withCloseButton={false} closeOnEscape={false} fullScreen>
      <Container size="md">
        {isLoading ? (
          <Center>
            <Loader size="lg" />
          </Center>
        ) : modelVersion ? (
          <FilesProvider model={modelVersion?.model} version={modelVersion}>
            <Stack gap="xl">
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap={8}>
                  <Link
                    legacyBehavior
                    href={getModelUrl({
                      modelId: modelVersion.model.id,
                      modelName: modelVersion.model.name,
                    })}
                    passHref
                    shallow
                  >
                    <Anchor size="xs">
                      <Group gap={4}>
                        <IconArrowLeft size={12} />
                        <Text inherit>Back to {modelVersion?.model?.name} page</Text>
                      </Group>
                    </Anchor>
                  </Link>
                  <Title order={1}>Manage Files</Title>
                  <Text size="sm" c="dimmed">
                    {modelVersion.model.name} &bull; {modelVersion.name}
                  </Text>
                </Stack>
                <SaveButton />
              </Group>
              <Files />
            </Stack>
          </FilesProvider>
        ) : (
          <NotFound />
        )}
      </Container>
    </Modal>
  );
}
