import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { ToggleImageFlagInput } from '~/server/schema/image.schema';

export function useToggleImageFlag() {
  const toggleImageFlagMutation = trpc.image.toggleImageFlag.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Image flag updated',
        message: 'The image flag has been successfully updated.',
      });
    },
    onError: (error: any) => showErrorNotification({ error: new Error(error.message) }),
  });

  return function ({ id, flag }: ToggleImageFlagInput) {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: `Toggle Image '${flag}' value`,
        message: 'Are you sure you want to update this value?',
        labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
        confirmProps: { color: 'red', loading: toggleImageFlagMutation.isLoading },
        onConfirm: async () => await toggleImageFlagMutation.mutateAsync({ id, flag }),
      },
    });
  };
}
