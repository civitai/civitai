import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

export function useRescanArticle() {
  const queryUtils = trpc.useUtils();

  const { mutateAsync, isLoading } = trpc.article.rescan.useMutation({
    async onSuccess(_data, variables) {
      showSuccessNotification({ message: 'Article sent for rescan' });
      await queryUtils.article.getScanStatus.invalidate({ id: variables.id });
      await queryUtils.article.getById.invalidate({ id: variables.id });
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not rescan article',
      });
    },
  });

  return {
    rescan: (articleId: number) => mutateAsync({ id: articleId }),
    isLoading,
  };
}
