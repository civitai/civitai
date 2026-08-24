import { keepPreviousData } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import type {
  CollaboratorRosterRow,
  PendingTransferRow,
  TransferListingFacts,
} from '~/components/Apps/AppCollaboratorsPanelView';
import {
  AppCollaboratorsPanelView,
  inviteBlockedReason,
  pickerExcludedUserIds,
  TRANSFER_PICKER_PLACEHOLDER,
} from '~/components/Apps/AppCollaboratorsPanelView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { AppRole, ListingCapability } from '~/shared/constants/app-capabilities.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { SCREENED_USER_ID_LIMIT } from '~/server/schema/blocks/app-collaborator.schema';
import { trpc } from '~/utils/trpc';

/**
 * Data container. Owns the `appCollaborators.*` calls this surface wires: `list`,
 * `invite`, `remove`, `setDisplayed`, `leave`, plus the OWNER half of ownership transfer
 * (`getPendingTransfer`, `initiateTransfer`, `cancelTransfer`).
 *
 * 🔴 THE TRANSFER READ IS OWNER-ONLY AT THE CALL SITE, not merely hidden in the View.
 * `getPendingTransfer` returns `null` to anyone who is neither the owner nor the
 * addressee — deliberately, so it cannot be used as an existence oracle — so an editor's
 * query would be a guaranteed-useless round trip on every render of the tab. `enabled`
 * keeps it from being issued at all.
 */
export function AppCollaboratorsPanel({
  appListingId,
  role,
  capabilities,
  listing,
}: {
  appListingId: string;
  role: AppRole;
  capabilities: Readonly<Record<ListingCapability, boolean>>;
  /**
   * 🔴 REQUIRED, DELIBERATELY. This is the field whose absence WAS the bug: the transfer
   * verdict is a property of the listing, so a caller that has an authoring context and
   * does not hand it over would put the tab back to learning the refusal from a mutation
   * error. Non-optional means `tsc` refuses the page that forgets it, rather than the page
   * silently rendering an enabled control again.
   */
  listing: TransferListingFacts;
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

  const isOwner = role === 'owner';
  const transferQuery = trpc.appCollaborators.getPendingTransfer.useQuery(
    { appListingId },
    { retry: false, enabled: isOwner }
  );
  const invalidateTransfer = () => {
    void utils.appCollaborators.getPendingTransfer.invalidate({ appListingId });
  };
  // 🔴 The refusal is held in STATE and rendered inline by the View, instead of being
  // thrown at a toast. A refusal names WHY the transfer cannot happen, and a transient
  // toast is exactly where a reason goes to die — leaving the owner with a control that
  // fails every time and nothing on screen explaining it.
  const [transferErrorMessage, setTransferErrorMessage] = useState<string | null>(null);
  const initiateTransfer = trpc.appCollaborators.initiateTransfer.useMutation({
    onSuccess: () => {
      setTransferErrorMessage(null);
      showSuccessNotification({
        message: 'Ownership offer sent. Nothing moves until they accept it.',
      });
      invalidateTransfer();
    },
    onError: (error) => setTransferErrorMessage(error.message ?? 'Something went wrong.'),
  });
  const cancelTransfer = trpc.appCollaborators.cancelTransfer.useMutation({
    onSuccess: () => {
      setTransferErrorMessage(null);
      showSuccessNotification({ message: 'Ownership offer withdrawn.' });
      invalidateTransfer();
    },
    onError: (error) => setTransferErrorMessage(error.message ?? 'Something went wrong.'),
  });

  /**
   * 🔴 SCREEN THE CANDIDATES THE PICKER IS OFFERING, AGAINST THE SERVER.
   *
   * The picker's candidates come out of user search, and a search hit is a cached document —
   * it can be out of date about the account it describes, including about its NAME. So the
   * picker cannot conclude anything about an account from the fact that search returned it,
   * and an owner choosing the top result must not be able to act on a document that is wrong.
   *
   * The ids are accumulated rather than replaced so an id already found ineligible stays
   * excluded as the query text changes — dropping it would put it back in the Meili filter,
   * back into the hits, and back on offer. Bounded by the screening call's own cap.
   */
  const [screenedUserIds, setScreenedUserIds] = useState<number[]>([]);
  const handlePickerHits = useCallback((ids: number[]) => {
    setScreenedUserIds((prev) => {
      const added = ids.filter((id) => !prev.includes(id));
      if (!added.length) return prev; // identical set -> same array, so the query does not re-issue
      return [...prev, ...added].slice(-SCREENED_USER_ID_LIMIT);
    });
  }, []);
  const screenQuery = trpc.appCollaborators.ineligibleTargets.useQuery(
    { appListingId, userIds: screenedUserIds },
    {
      // Owner-only: the proc asserts ownership of the listing, and only an owner is shown the
      // invite picker at all, so an editor must not issue this at all rather than 403 on every
      // render of a tab they are allowed to see.
      enabled: role === 'owner' && screenedUserIds.length > 0,
      staleTime: 60_000,
      retry: false,
      // 🔴 Without this, `data` snaps back to undefined on every key change, so an id already
      // known ineligible briefly returns to the picker and is selectable until the new round
      // trip lands. The server still refuses it, but the picker should not offer it at all.
      placeholderData: keepPreviousData,
    }
  );
  const ineligibleUserIds = screenQuery.data ?? [];

  const rows = (listQuery.data ?? []) as CollaboratorRosterRow[];
  const busy = invite.isPending || remove.isPending || setDisplayed.isPending || leave.isPending;
  const transferBusy = initiateTransfer.isPending || cancelTransfer.isPending;

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
            const blocked = inviteBlockedReason(rows, selected.id, ineligibleUserIds);
            if (blocked) {
              showErrorNotification({
                title: blocked.title,
                error: new Error(blocked.message),
              });
              return;
            }
            invite.mutate({ appListingId, targetUserId: selected.id });
          }}
          onHits={handlePickerHits}
          filters={[currentUser?.id, ...pickerExcludedUserIds(rows, ineligibleUserIds)]
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
      pendingTransfer={(transferQuery.data ?? null) as PendingTransferRow | null}
      // The listing facts the View reaches the up-front transfer verdict from. Forwarded
      // whole rather than pre-computed here, so the rule has exactly one call site.
      listing={listing}
      transferErrorMessage={transferErrorMessage}
      transferBusy={transferBusy}
      onCancelTransfer={(transferId) => cancelTransfer.mutate({ transferId })}
      transferPicker={
        <QuickSearchDropdown
          disableInitialSearch
          supportedIndexes={['users']}
          startingIndex="users"
          showIndexSelect={false}
          dropdownItemLimit={25}
          disabled={transferBusy}
          placeholder={TRANSFER_PICKER_PLACEHOLDER}
          onItemSelected={(_entity, item) => {
            const selected = item as SearchIndexDataMap['users'][number];
            setTransferErrorMessage(null);
            initiateTransfer.mutate({ appListingId, toUserId: selected.id });
          }}
          // The current owner cannot be the recipient — the service refuses it with
          // "You already own this app", and the DB carries a `from <> to` CHECK.
          filters={[currentUser?.id]
            .filter((id): id is number => !!id)
            .map((id) => `AND NOT id=${id}`)
            .join(' ')
            .slice(4)}
        />
      }
    />
  );
}
