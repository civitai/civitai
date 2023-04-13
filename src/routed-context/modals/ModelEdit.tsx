import {
  Anchor,
  Button,
  Modal,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons';
import Link from 'next/link';
import { useMemo } from 'react';
import { z } from 'zod';

import { NotFound } from '~/components/AppLayout/NotFound';
import { ModelUpsertForm } from '~/components/Resource/Forms/ModelUpsertForm';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { closeRoutedContext } from '~/providers/RoutedContextProvider';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { trpc } from '~/utils/trpc';

export default createRoutedContext({
  schema: z.object({
    modelId: z.number(),
  }),
  authGuard: true,
  Element: ({ context, props: { modelId } }) => {
    const currentUser = useCurrentUser();
    const { data, isLoading: loadingModel } = trpc.model.getById.useQuery({ id: modelId });
    const model = useMemo(
      () => ({
        ...data,
        tagsOnModels: data?.tagsOnModels.map((tom) => tom.tag),
      }),
      [data]
    );

    const isModerator = currentUser?.isModerator ?? false;
    const isOwner = model?.user?.id === currentUser?.id || isModerator;
    const deleted = !!model?.deletedAt && model?.status === 'Deleted';
    if (!isOwner || deleted) closeRoutedContext();

    return (
      <Modal opened={context.opened} onClose={context.close} fullScreen withCloseButton={false}>
        <Container size="sm">
          {loadingModel ? (
            <Center>
              <Loader size="lg" />
            </Center>
          ) : data ? (
            <Stack spacing="xl">
              <Link href={`/models/${modelId}`} passHref shallow>
                <Anchor size="sm">
                  <Group spacing={4}>
                    <IconArrowLeft size={18} strokeWidth={1.5} />
                    <Text inherit>Back to {model.name} page</Text>
                  </Group>
                </Anchor>
              </Link>
              <Title order={1}>Edit Model</Title>
              <ModelUpsertForm model={model} onSubmit={context.close}>
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
              </ModelUpsertForm>
            </Stack>
          ) : (
            <NotFound />
          )}
        </Container>
      </Modal>
    );
  },
});
