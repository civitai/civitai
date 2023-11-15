import { Anchor, Center, Container, Group, Loader, Modal, Stack, Text, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import Link from 'next/link';

import { NotFound } from '~/components/AppLayout/NotFound';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Files } from '~/components/Resource/Files';
import { FilesProvider } from '~/components/Resource/FilesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export default function FilesEditModal({ modelVersionId }: { modelVersionId: number }) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const { data: modelVersion, isLoading } = trpc.modelVersion.getById.useQuery({
    id: modelVersionId,
    withFiles: true,
  });

  const isModerator = currentUser?.isModerator ?? false;
  const isOwner = modelVersion?.model?.user.id === currentUser?.id || isModerator;
  if (!isLoading && modelVersion && !isOwner) dialog.onClose();

  return (
    <Modal {...dialog} withCloseButton={false} closeOnEscape={false} fullScreen>
      <Container size="sm">
        {isLoading ? (
          <Center>
            <Loader size="lg" />
          </Center>
        ) : modelVersion ? (
          <Stack spacing="xl">
            <Link href={`/models/${modelVersion?.model.id}`} passHref shallow>
              <Anchor size="xs">
                <Group spacing={4}>
                  <IconArrowLeft size={12} />
                  <Text inherit>Back to {modelVersion?.model?.name} page</Text>
                </Group>
              </Anchor>
            </Link>
            <Title order={1}>Manage Files</Title>
            <FilesProvider model={modelVersion?.model} version={modelVersion}>
              <Files />
            </FilesProvider>
          </Stack>
        ) : (
          <NotFound />
        )}
      </Container>
    </Modal>
  );
}
