import { Modal, Center, Loader } from '@mantine/core';

import { z } from 'zod';
import { ModelForm } from '~/components/Model/ModelForm/ModelForm';

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
    const { data: model, isLoading: loadingModel } = trpc.model.getById.useQuery({ id: modelId });

    const isModerator = currentUser?.isModerator ?? false;
    const isOwner = model?.user.id === currentUser?.id || isModerator;
    const deleted = !!model?.deletedAt && model?.status === 'Deleted';
    if ((!isOwner && !isModerator) || deleted) closeRoutedContext();

    return (
      <Modal opened={context.opened} onClose={context.close} fullScreen withCloseButton={false}>
        {loadingModel ? (
          <Center>
            <Loader />
          </Center>
        ) : model ? (
          <ModelForm model={model} />
        ) : null}
      </Modal>
    );
  },
});
