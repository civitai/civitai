import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import type { CollaboratorRosterRow } from '~/components/Apps/AppCollaboratorsPanelView';
import {
  AppCollaboratorsPanelView,
  inviteBlockedReason,
  pickerExcludedUserIds,
} from '~/components/Apps/AppCollaboratorsPanelView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { AppRole, ListingCapability } from '~/shared/constants/app-capabilities.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Data container. Owns the four `appCollaborators.*` calls this surface wires:
 * `list`, `invite`, `remove`, `setDisplayed` and `leave`.
 */
export function AppCollaboratorsPanel({
  appListingId,
  role,
  capabilities,
}: {
  appListingId: string;
  role: AppRole;
  capabilities: Readonly<Record<ListingCapability, boolean>>;
}) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const listQuery = trpc.appCollaborators.list.useQuery({ appListingId }, { retry: false });

  const invalidate = () => {
    void utils.appCollaborators.list.invalidate({ appListingId });
  };
  const onError = (error: { message?: string }) =>
    showErrorNotification({
      title: 'Collaborators',
      error: new Error(error.message ?? 'Something went wrong.'),
    });

  const invite = trpc.appCollaborators.invite.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Invitation sent.' });
      invalidate();
    },
    onError,
  });
  const remove = trpc.appCollaborators.remove.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Collaborator removed.' });
      invalidate();
    },
    onError,
  });
  const setDisplayed = trpc.appCollaborators.setDisplayed.useMutation({
    onSuccess: () => invalidate(),
    onError,
  });
  const leave = trpc.appCollaborators.leave.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'You have left this app.' });
      invalidate();
    },
    onError,
  });

  const rows = (listQuery.data ?? []) as CollaboratorRosterRow[];
  const busy = invite.isPending || remove.isPending || setDisplayed.isPending || leave.isPending;

  return (
    <AppCollaboratorsPanelView
      role={role}
      capabilities={capabilities}
      rows={rows}
      isLoading={listQuery.isLoading}
      errorMessage={listQuery.error?.message ?? null}
      viewerUserId={currentUser?.id ?? null}
      busy={busy}
      renderUser={(userId) => <UserAvatar userId={userId} withUsername size="sm" />}
      userPicker={
        <QuickSearchDropdown
          disableInitialSearch
          supportedIndexes={['users']}
          startingIndex="users"
          showIndexSelect={false}
          dropdownItemLimit={25}
          disabled={busy}
          placeholder="Search for a community member to invite"
          onItemSelected={(_entity, item) => {
            const selected = item as SearchIndexDataMap['users'][number];
            // Both the guard and the picker filter read the SAME two pure helpers, so they
            // cannot disagree about who is offerable — and a REJECTED seat is offerable.
            const blocked = inviteBlockedReason(rows, selected.id);
            if (blocked) {
              showErrorNotification({
                title: blocked.title,
                error: new Error(blocked.message),
              });
              return;
            }
            invite.mutate({ appListingId, targetUserId: selected.id });
          }}
          filters={[currentUser?.id, ...pickerExcludedUserIds(rows)]
            .filter((id): id is number => !!id)
            .map((id) => `AND NOT id=${id}`)
            .join(' ')
            .slice(4)}
        />
      }
      onRemove={(userId) => remove.mutate({ appListingId, targetUserId: userId })}
      onSetDisplayed={(displayed, targetUserId) =>
        setDisplayed.mutate({ appListingId, displayed, targetUserId })
      }
      onLeave={() => leave.mutate({ appListingId })}
    />
  );
}
