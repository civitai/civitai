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
import { IconArrowLeft } from '@tabler/icons';
import Link from 'next/link';
import { z } from 'zod';

import { Files } from '~/components/Resource/Files';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { closeRoutedContext } from '~/providers/RoutedContextProvider';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { trpc } from '~/utils/trpc';

export default createRoutedContext({
  schema: z.object({
    modelVersionId: z.number(),
  }),
  authGuard: true,
  Element: ({ context, props: { modelVersionId } }) => {
    const currentUser = useCurrentUser();
    const { data: modelVersion, isLoading } = trpc.modelVersion.getById.useQuery({
      id: modelVersionId,
      withFiles: true,
    });

    const isModerator = currentUser?.isModerator ?? false;
    const isOwner = modelVersion?.model?.user.id === currentUser?.id || isModerator;
    if (!isOwner) closeRoutedContext();

    return (
      <Modal opened={context.opened} onClose={context.close} fullScreen>
        <Container size="sm">
          {isLoading ? (
            <Center>
              <Loader size="lg" />
            </Center>
          ) : (
            <Stack spacing="xl">
              <Link href={`/models/v2/${modelVersion?.model.id}`} passHref shallow>
                <Anchor size="xs">
                  <Group spacing={4}>
                    <IconArrowLeft size={12} />
                    <Text inherit>Back to {modelVersion?.model?.name} page</Text>
                  </Group>
                </Anchor>
              </Link>
              <Title order={1}>Manage Files</Title>
              <Files model={modelVersion?.model} version={modelVersion} />
              <Group position="right">
                <Button variant="default" onClick={context.close}>
                  Cancel
                </Button>
              </Group>
            </Stack>
          )}
        </Container>
      </Modal>
    );
  },
});
