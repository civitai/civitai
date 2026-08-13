import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import type { CollaboratorRosterRow } from '~/components/Apps/AppCollaboratorsPanelView';
import { AppCollaboratorsPanelView } from '~/components/Apps/AppCollaboratorsPanelView';
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
            if (rows.some((r) => r.userId === selected.id)) return;
            invite.mutate({ appListingId, targetUserId: selected.id });
          }}
          filters={[{ id: currentUser?.id }, ...rows.map((r) => ({ id: r.userId }))]
            .filter((x) => !!x?.id)
            .map((x) => `AND NOT id=${x.id}`)
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
