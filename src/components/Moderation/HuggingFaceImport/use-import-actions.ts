import { confirmForce } from '~/components/Moderation/HuggingFaceImport/confirm-force';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Result =
  | { ok: true }
  | { ok: false; reason: 'state' }
  | { ok: false; reason: 'storage'; message: string };

/**
 * The per-import actions, wired once: both tabs offer Delete, and a storage refusal has to end in
 * the same choice wherever it is raised.
 */
export function useImportActions(nameOf: (id: number) => string = () => 'this import') {
  const queryUtils = trpc.useUtils();

  const onError = (error: { message: string }) =>
    showErrorNotification({ title: 'Action failed', error: new Error(error.message) });

  // `ok: false` means the row moved on before the click landed — a cancel on a row that just
  // completed, say. Invalidating and saying nothing renders a refusal as a successful no-op.
  const onSettled = (result: { ok: boolean; reason?: string } | undefined, action: string) => {
    if (result && !result.ok && result.reason !== 'storage')
      showErrorNotification({
        title: `Could not ${action}`,
        error: new Error('The import is no longer in a state where that applies. Refreshed.'),
      });
    return Promise.all([
      queryUtils.huggingFaceImport.getAll.invalidate(),
      queryUtils.huggingFaceImport.getCounts.invalidate(),
    ]);
  };

  /** Storage cleanup failed: ask, then repeat the same call with `force`. */
  const settleOrAskToForce = (
    result: Result,
    input: { id: number; force?: boolean },
    action: 'Delete' | 'Restart',
    again: (input: { id: number; force: boolean }) => void
  ): Promise<unknown> | void => {
    if (!result.ok && result.reason === 'storage' && !input.force)
      return confirmForce({
        action,
        what: nameOf(input.id),
        message: result.message,
        onConfirm: () => again({ id: input.id, force: true }),
      });
    return onSettled(result, action.toLowerCase());
  };

  const detach = trpc.huggingFaceImport.detach.useMutation({
    onError,
    onSuccess: (result) => onSettled(result, 'detach'),
  });
  const cancel = trpc.huggingFaceImport.cancel.useMutation({
    onError,
    onSuccess: (result) => onSettled(result, 'cancel'),
  });
  const remove = trpc.huggingFaceImport.delete.useMutation({
    onError,
    onSuccess: (result, input): Promise<unknown> | void =>
      settleOrAskToForce(result, input, 'Delete', (again) => remove.mutate(again)),
  });
  const retry = trpc.huggingFaceImport.retry.useMutation({
    onError,
    onSuccess: (result, input): Promise<unknown> | void =>
      settleOrAskToForce(result, input, 'Restart', (again) => retry.mutate(again)),
  });

  return { cancel, retry, remove, detach };
}

export type ImportActions = ReturnType<typeof useImportActions>;
