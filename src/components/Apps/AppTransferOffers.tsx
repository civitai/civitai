import {
  AppTransferOffersView,
  invalidationsForTransferResponse,
} from '~/components/Apps/AppTransferOffersView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Data container for the recipient's ownership-offer inbox.
 *
 * Wires three of the four transfer procs: `listMyPendingTransfers` (the read that made
 * the feature reachable), `acceptTransfer`, and `cancelTransfer` — the last one is how a
 * recipient DECLINES, since either party may cancel a pending offer and both land on the
 * same terminal state.
 */
export function AppTransferOffers() {
  const utils = trpc.useUtils();
  const transfersQuery = trpc.appCollaborators.listMyPendingTransfers.useQuery(undefined, {
    retry: false,
  });

  // 🔴 DRIVEN FROM the exported list rather than a parallel copy of it — a pure function
  // that merely DESCRIBES what the callback does is a declaration, not a code path.
  const invalidate = (accept: boolean) => {
    const invalidators = {
      'appCollaborators.listMyPendingTransfers': () =>
        utils.appCollaborators.listMyPendingTransfers.invalidate(),
      'appListings.listMine': () => utils.appListings.listMine.invalidate(),
      'blocks.getNavSummary': () => utils.blocks.getNavSummary.invalidate(),
    } as const;
    for (const key of invalidationsForTransferResponse(accept)) void invalidators[key]();
  };

  const onError = (error: { message?: string }) =>
    showErrorNotification({
      title: 'App ownership transfer',
      error: new Error(error.message ?? 'Something went wrong.'),
    });

  const accept = trpc.appCollaborators.acceptTransfer.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Ownership accepted — the app is now yours.' });
      invalidate(true);
    },
    onError,
  });
  const decline = trpc.appCollaborators.cancelTransfer.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Ownership offer declined.' });
      invalidate(false);
    },
    onError,
  });

  const busyTransferId = accept.isPending
    ? accept.variables?.transferId ?? null
    : decline.isPending
    ? decline.variables?.transferId ?? null
    : null;

  return (
    <AppTransferOffersView
      /**
       * 🔴 NO CAST. There used to be an `as IncomingTransferRow[]` here, against a
       * hand-written structural duplicate of the service's return type — and a cast to a
       * wider type is LEGAL, so `tsc` could not see the server drifting from the View at
       * the one hop where that drift is invisible at runtime too. #3935 fixed the same
       * hole on the owner's page (F3). `IncomingTransferRow` is now derived from
       * `IncomingTransferView`, so the tRPC output type is checked against it directly and
       * a field the service stops sending fails HERE.
       */
      transfers={transfersQuery.data ?? []}
      isLoading={transfersQuery.isLoading}
      errorMessage={transfersQuery.error?.message ?? null}
      busyTransferId={busyTransferId}
      onRespond={(transferId, isAccept) =>
        isAccept ? accept.mutate({ transferId }) : decline.mutate({ transferId })
      }
      renderOfferer={(userId) => <UserAvatar userId={userId} withUsername size="xs" />}
    />
  );
}
