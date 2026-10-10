import { Alert, Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconEye, IconEyeOff, IconUsers } from '@tabler/icons-react';
import { useCallback, useState } from 'react';

import { ownerListingState, ownerStateChip } from '~/components/Apps/offsiteOwnerControls';
import {
  OwnerUnpublishModal,
  type OwnerUnpublishVariant,
} from '~/components/Apps/ownerListingModals';
import {
  republishSuccessMessage,
  showModRemovedNotice,
  showRepublish,
  showUnpublish,
  showVisibility,
} from '~/components/Apps/listingPublishingActions';
import { ListingVisibilityModal } from '~/components/Apps/ListingVisibilityModal';
import {
  visibilityPostApprovalPrompt,
  visibilitySummaryLabel,
} from '~/components/Apps/listingVisibilityCopy';
import type { ListingKind } from '~/shared/constants/app-capabilities.constants';
import type { AppRole } from '~/shared/constants/app-capabilities.constants';
import type { AppListingVisibility } from '~/shared/utils/app-listing-visibility';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The authoring page's **Publishing** tab — the owner's Unpublish / Republish pair.
 *
 * 🔴 THIS IS WHERE THE ONE-WAY DOOR IS CLOSED, and the reason the tab exists on a status
 * the rest of the page refuses. An owner Unpublish and a moderator takedown BOTH write
 * `AppListing.status = 'removed'`, so a page gated on the authorable statuses cannot show
 * an owner the way back from their own action — `republishOwnListing` is the only
 * owner-reachable route from `removed` to `approved`, and without it the app can be
 * restored only by a moderator `relistListing`. `editorTabsFor` therefore opens exactly
 * this tab (and History) on a `removed` listing and withholds every content tab —
 * `details`, `media`, `manifest`, `earnings` and, above all, `collaborators`.
 *
 * 🔴 THE CONTROLS ARE OWNER-ONLY, AND THAT IS ENFORCED THREE TIMES OVER, deliberately.
 * `editorTabsFor` does not offer an editor the tab; {@link showUnpublish}/
 * {@link showRepublish} refuse a non-owner row here; and both procs are owner-scoped
 * server-side. The middle one is not redundant with the first: this component is exported
 * and mountable, and a tab set is a UI narrowing rather than a gate.
 *
 * 🔴 THE STATE ROUTING IS NOT RE-DERIVED HERE — see `listingPublishingActions.ts`, whose
 * ledger the browser test compares this panel's rendered control set against.
 */

export type ListingPublishingPanelProps = {
  appListingId: string;
  slug: string;
  kind: ListingKind;
  role: AppRole;
  /** The LISTING's own status — `draft|pending|approved|rejected|removed`. */
  status: string;
  /**
   * The listing's most-recent moderation-event action, NORMALISED by the server to
   * `owner-unpublish` | `other` | `null`.
   *
   * 🔴 IT IS THE ONLY THING SEPARATING "I unpublished this and may put it back" from "a
   * moderator removed this". `status` reads `removed` for both. Absent is read as a
   * moderator removal — the safe direction, since it withholds a button the server would
   * refuse rather than inventing one.
   */
  lastModerationAction?: string | null;
  /**
   * The listing's per-listing VISIBILITY LEVEL, or `null` for "no choice expressed".
   *
   * 🔴 `null` IS NOT `private` — it resolves to the pre-feature rule for this status, which
   * on an approved listing means visible to everyone. Defaulted to `null` so a caller that
   * has not been updated renders the unset state rather than claiming a level.
   */
  visibility?: AppListingVisibility | null;
  /**
   * False ⇒ the manual-apply migration is not applied in this environment. Defaults to
   * TRUE because every real caller passes the server's answer, and the server refuses the
   * write authoritatively either way; defaulting to `false` would disable the control on
   * every un-updated caller and read as the feature being broken.
   */
  visibilityAvailable?: boolean;
  /** Invalidate the surrounding reads after a successful write. */
  onChanged?: () => void;
};

/** The container the publishing ledger enumerates. See `listingPublishingActions.ts`. */
export const PUBLISHING_ACTIONS_TESTID = 'apps-publishing-actions';

export function ListingPublishingPanel({
  appListingId,
  slug,
  kind,
  role,
  status,
  lastModerationAction = null,
  visibility = null,
  visibilityAvailable = true,
  onChanged,
}: ListingPublishingPanelProps) {
  const [unpublishOpen, setUnpublishOpen] = useState(false);
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const utils = trpc.useUtils();

  const refresh = useCallback(() => {
    // 🔴 `getAuthoringContext` FIRST, because it is the read this very panel's props come
    // from: without invalidating it the page keeps rendering `status: 'approved'` after a
    // successful unpublish and the Unpublish button stays on screen, so the author's next
    // click hits a listing that is already removed. `listMine` is invalidated too because
    // `/apps/mine` partitions on the same column.
    void utils.appListings.getAuthoringContext.invalidate();
    void utils.appListings.listMine.invalidate();
    void utils.appListings.listingHistory.invalidate();
    onChanged?.();
  }, [utils, onChanged]);

  const republish = trpc.appListings.republishOwnListing.useMutation({
    // 🔴 The message is DERIVED from the server's answer, never assumed: a republish whose
    // assets changed since the last approval lands in `pending`, not live. See
    // {@link republishSuccessMessage}.
    onSuccess: (data) => {
      showSuccessNotification({ message: republishSuccessMessage(data, kind) });
      refresh();
    },
    /**
     * 🔴 THE SERVER STAYS AUTHORITATIVE. `showRepublish` is a CLIENT MIRROR of the
     * last-event guard, so a listing a moderator took down between the render and the click
     * still 403s ("This listing was removed by a moderator and cannot be restored by its
     * owner."). Surfacing that message rather than swallowing it is what makes the mirror
     * safe to have.
     */
    onError: (e) =>
      showErrorNotification({ title: 'Republish failed', error: new Error(e.message) }),
  });

  const row = { status, lastModerationAction, role };
  const state = ownerListingState({ listingStatus: status, lastModerationAction });
  const chip = ownerStateChip(state);
  const canUnpublish = showUnpublish(row);
  const canRepublish = showRepublish(row);
  // 🔴 OWNER-GATED — see `showVisibility`. ⚠️ This comment said "NOT role-gated" on the
  // grounds that the level proc admits an accepted collaborator. That is true of the PROC and
  // was unreachable in the product: `editorTabsFor` withholds this tab from an editor, so the
  // branch described a configuration nothing can mount. Re-enabling the seat means widening
  // that tab's `role` term FIRST — the server will already allow it.
  const canSetVisibility = showVisibility(row);
  const postApprovalPrompt = visibilityPostApprovalPrompt(visibility, status);
  // On-site apps go OFFLINE; an off-site listing is only delisted from the store.
  const variant: OwnerUnpublishVariant = kind === 'onsite' ? 'offline' : 'store';

  return (
    <Stack gap="md" data-testid="apps-publishing-panel">
      <Group gap="xs">
        <Text size="sm" c="dimmed">
          Store status
        </Text>
        {/*
          🔴 A REMOVED LISTING'S BADGE SAYS *WHO* REMOVED IT. `status` reads `removed` for an
          owner self-unpublish and for a moderator takedown alike, which is precisely the
          distinction the author needs — one of those they can undo themselves and the other
          they cannot. `ownerStateChip` returns null for every other state, so the plain
          status word shows there. Same function the `/apps/mine` badge uses.
        */}
        <Badge
          variant="outline"
          color={chip ? chip.color : 'gray'}
          data-testid="apps-publishing-status"
        >
          {chip ? chip.label : status}
        </Badge>
      </Group>

      {showModRemovedNotice(row) ? (
        /*
         * 🔴 IT STATES THE CONSEQUENCE, NOT A CAUSE, AND THE DIFFERENCE IS TRUTH. An earlier
         * wording read "Removed by a moderator — contact them to restore it", which asserts
         * WHO removed the app. That is not what this state means: the server's guard refuses
         * an owner republish whenever the newest moderation event is anything other than
         * `owner-unpublish`, and `resolveReport`/`dismissReport` write event rows too. So an
         * owner who unpublishes their own app and then has a pre-existing report closed by a
         * moderator lands here — the refusal is real and the mirror is faithful, but nobody
         * removed their app.
         *
         * 🔴 IT IS ALSO THE POSITIVE CONTROL FOR THIS STATE'S EMPTY ACTION SET. With
         * `history` gone from the ledger vocabulary, `mod-removed` declares NO controls, and
         * an empty container is indistinguishable from a dropped button. Something has to be
         * on screen, found by the same mechanism the absences are asserted with.
         */
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          data-testid="apps-publishing-mod-removed"
        >
          Only a moderator can restore this listing.
        </Alert>
      ) : null}

      {/*
        The two states with no control and no takedown to explain: a listing that was never
        approved. Same positive-control duty as the notice above.
      */}
      {!canUnpublish && !canRepublish && !showModRemovedNotice(row) ? (
        <Alert color="gray" variant="light" data-testid="apps-publishing-not-live">
          {role === 'owner'
            ? 'This app is not live in the store, so there is nothing to unpublish yet.'
            : 'Only the app owner can publish or unpublish this listing.'}
        </Alert>
      ) : null}

      {postApprovalPrompt ? (
        /*
         * 🔴 FINDING F11'S ENTIRE OWNER-SIDE SIGNAL. Nothing clears the level at approval —
         * deliberately, because that would mean the approve path writing this column (the
         * eight-scattered-writes hazard the `@no-type` shape exists to avoid) and it would
         * discard a choice an owner may really have wanted. So an app approved while set to
         * `moderators` goes LIVE VISIBLE TO MODERATORS ONLY, and without this line the
         * owner's only clue is that nobody ever uses their app. The wording and the
         * fire/stay-silent arms are in `visibilityPostApprovalPrompt`, under the blocking
         * unit project, because this branch itself is only reachable in report-only tests.
         */
        <Alert
          color="yellow"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          data-testid="apps-publishing-visibility-prompt"
        >
          {postApprovalPrompt}
        </Alert>
      ) : null}

      <Group gap="xs" data-testid={PUBLISHING_ACTIONS_TESTID}>
        {canUnpublish && (
          <Button
            variant="default"
            color="orange"
            leftSection={<IconEyeOff size={14} />}
            onClick={() => setUnpublishOpen(true)}
            data-testid="apps-publishing-unpublish"
            data-author-action="unpublish"
          >
            Unpublish
          </Button>
        )}
        {canRepublish && (
          <Button
            variant="default"
            color="green"
            leftSection={<IconEye size={14} />}
            disabled={republish.isPending}
            loading={republish.isPending}
            onClick={() => republish.mutate({ appListingId })}
            data-testid="apps-publishing-republish"
            data-author-action="republish"
          >
            Republish
          </Button>
        )}
        {canSetVisibility && (
          /*
           * 🔴 THE `data-author-action` IS LOAD-BEARING, NOT DECORATION. The browser ledger
           * enumerates `button, a[href]` in this container and FAILS on any such element
           * that carries no such attribute, so omitting it would not hide the control — it
           * would break the test with an "undeclared control" error. It is also why this is
           * a Button opening a modal rather than an inline Select: an `<input>` is invisible
           * to that enumeration, which would make the ledger read the control as MISSING.
           */
          <Button
            variant="default"
            leftSection={<IconUsers size={14} />}
            onClick={() => setVisibilityOpen(true)}
            data-testid="apps-publishing-visibility"
            data-author-action="visibility"
          >
            Visibility: {visibilitySummaryLabel(visibility, status)}
          </Button>
        )}
      </Group>

      {/*
        🔴 CONFIRM-GATED, REUSING THE EXISTING MODAL RATHER THAN A FRESH `confirm()`.
        `OwnerUnpublishModal` already owns the `unpublishOwnListing` mutation, the optional
        reason field and the two copy variants; a second implementation would be the place
        the two surfaces come to disagree about what unpublishing does.
      */}
      <OwnerUnpublishModal
        target={unpublishOpen ? { id: appListingId, slug } : null}
        onClose={() => setUnpublishOpen(false)}
        onDone={refresh}
        testIdPrefix="apps-publishing"
        variant={variant}
      />

      {/*
        Same confirm-gated-modal shape as the unpublish pair above, for the same reason: the
        level picker owns its own mutation and its own copy, so the panel stays a renderer.
        Mounted unconditionally (it returns `null` without a target) to match the sibling.
      */}
      <ListingVisibilityModal
        target={visibilityOpen ? { id: appListingId, slug } : null}
        status={status}
        currentVisibility={visibility}
        available={visibilityAvailable}
        onClose={() => setVisibilityOpen(false)}
        onDone={refresh}
        testIdPrefix="apps-publishing"
      />
    </Stack>
  );
}
