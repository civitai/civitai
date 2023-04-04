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

import { NotFound } from '~/components/AppLayout/NotFound';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
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
    });

    const isModerator = currentUser?.isModerator ?? false;
    const isOwner = modelVersion?.model?.user.id === currentUser?.id || isModerator;
    if (!isOwner) closeRoutedContext();

    return (
      <Modal opened={context.opened} onClose={context.close} withCloseButton={false} fullScreen>
        <Container size="sm">
          {isLoading ? (
            <Center>
              <Loader size="lg" />
            </Center>
          ) : modelVersion ? (
            <Stack spacing="xl">
              <Link href={`/models/${modelVersion?.model.id}`} passHref shallow>
                <Anchor size="sm">
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
                onSubmit={() => context.close()}
              >
                {({ loading }) => (
                  <Group mt="xl" position="right">
                    <Button variant="default" onClick={context.close}>
                      Cancel
                    </Button>
                    <Button type="submit" loading={loading}>
                      Save
                    </Button>
                  </Group>
                )}
              </ModelVersionUpsertForm>
            </Stack>
          ) : (
            <NotFound />
          )}
        </Container>
      </Modal>
    );
  },
});
