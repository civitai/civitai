import { Alert, Button, Code, Group, Modal, Radio, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import {
  visibilityCeilingReason,
  visibilityOptionsFor,
  visibilitySummaryLabel,
} from '~/components/Apps/listingVisibilityCopy';
import type { AppListingVisibility } from '~/shared/utils/app-listing-visibility';
import { isAppListingVisibility } from '~/shared/utils/app-listing-visibility';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * The per-listing VISIBILITY LEVEL picker, for the authoring page's **Publishing** tab.
 *
 * 🔴 A MODAL RATHER THAN AN INLINE SELECT, AND THE REASON IS THE LEDGER. The publishing
 * panel's control set is enforced by a set-equality guard that enumerates
 * `button, a[href]` inside the panel's action container and REFUSES any such element
 * without a `data-author-action` attribute. An inline Mantine `Select` renders an
 * `<input>`, which that enumeration cannot see — so the ledger would read the control as
 * missing. One `<button>` in the container plus a modal is the shape the panel already
 * uses for `OwnerUnpublishModal`, and the browser ledger test separately MEASURES that a
 * modal's own buttons land outside the container rather than assuming the portal does it.
 *
 * 🔴 EVERY COPY AND ENABLEMENT DECISION IS IMPORTED, NOT WRITTEN HERE. See
 * `listingVisibilityCopy.ts`: browser-mode suites are report-only in CI and unrunnable on
 * this workstation, so logic living in a `.tsx` branch is logic nothing blocking checks.
 * This component is deliberately a thin renderer over functions the blocking `unit`
 * project drives.
 *
 * ⚠️ IT IS OWNER-ONLY IN PRACTICE, AND THIS PARAGRAPH CLAIMED THE OPPOSITE AS THE REASON
 * FOR THE FILE EXISTING. `setListingVisibilityAsOwner` does refuse only a caller with no
 * role, so the SERVER would admit an accepted collaborator — but `editorTabsFor` withholds
 * the Publishing tab from an editor, so this modal is only ever mounted for an owner. The
 * file stays separate from `ownerListingModals.tsx` for a smaller but real reason: this one
 * needs no `reason` field and has its own enablement rules, and the moderator variant is a
 * third shape again. Do not restore the role claim without widening the tab's `role` term.
 */

export type ListingVisibilityTarget = { id: string; slug: string } | null;

export function ListingVisibilityModal({
  target,
  status,
  currentVisibility,
  available,
  onClose,
  onDone,
  testIdPrefix,
}: {
  target: ListingVisibilityTarget;
  /** The LIVE parent listing's status — drives the review ceiling. */
  status: string;
  /** The stored level, or `null` for "no choice expressed". NOT the same as `private`. */
  currentVisibility: AppListingVisibility | null;
  /** False ⇒ the manual-apply migration is not applied here; no write may name the column. */
  available: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  testIdPrefix: string;
}) {
  /**
   * 🔴 THE EMPTY STRING IS THE "UNSET" SENTINEL, AND IT IS NOT `private`. `Radio.Group`
   * needs a string, and `null` is not one. Mapping an unset level onto `'private'` would
   * pre-select a value the owner never chose — and on an approved listing that is the
   * OPPOSITE of its real behaviour (unset resolves to the public baseline), so a single
   * Save would hide a live app. So unset renders as NO radio selected.
   */
  const [choice, setChoice] = useState<string>(currentVisibility ?? '');

  // Re-seed when the modal is opened for a different listing, or after the underlying read
  // refreshes — otherwise a second open shows the first listing's choice.
  useEffect(() => {
    setChoice(currentVisibility ?? '');
  }, [currentVisibility, target?.id]);

  const utils = trpc.useUtils();
  const mutation = trpc.appListings.setListingVisibility.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Visibility updated.' });
      // The authoring context is the read this control's props come from; without
      // invalidating it the modal reopens on the stale level.
      void utils.appListings.getAuthoringContext.invalidate();
      void utils.appListings.listMine.invalidate();
      await onDone();
      onClose();
    },
    /**
     * 🔴 THE SERVER STAYS AUTHORITATIVE. The option list is a CLIENT MIRROR of the review
     * ceiling, so a listing whose status moved between render and click still refuses
     * ("…exceeds what this listing's review state allows"), and an un-migrated environment
     * refuses via `assertVisibilityWritable`. Surfacing those messages rather than
     * swallowing them is what makes the mirror safe to have.
     */
    onError: (e) =>
      showErrorNotification({ title: 'Could not update visibility', error: new Error(e.message) }),
  });

  function close() {
    if (mutation.isPending) return;
    onClose();
  }

  if (!target) return null;

  const options = visibilityOptionsFor(status);
  const ceilingReason = visibilityCeilingReason(status);
  const dirty = choice !== (currentVisibility ?? '');
  const chosenIsSettable =
    isAppListingVisibility(choice) && options.some((o) => o.value === choice && o.enabled);

  return (
    <Modal
      opened={!!target}
      onClose={close}
      title={
        <Text fw={600}>
          Visibility for <Code>{target.slug}</Code>
        </Text>
      }
      centered
    >
      <Stack gap="md">
        {!available ? (
          /*
           * 🔴 DISABLED AND EXPLAINED, NOT HIDDEN. `visibilityAvailable: false` means the
           * manual-apply migration has not been run in THIS environment — a deploy-order
           * state, not a property of the listing. Hiding the control would make a missing
           * migration look like a missing feature; the write path has no missing-column
           * degradation by design, so offering it here would produce a 500.
           */
          <Alert
            color="yellow"
            variant="light"
            icon={<IconAlertTriangle size={16} />}
            data-testid={`${testIdPrefix}-visibility-unavailable`}
          >
            <Text size="sm">
              Visibility levels are not available in this environment yet. Nothing is wrong with
              your app — a database migration is still pending.
            </Text>
          </Alert>
        ) : null}

        <Text size="sm" c="dimmed" data-testid={`${testIdPrefix}-visibility-current`}>
          Currently: {visibilitySummaryLabel(currentVisibility, status)}
        </Text>

        {ceilingReason ? (
          <Alert
            color="blue"
            variant="light"
            icon={<IconInfoCircle size={16} />}
            data-testid={`${testIdPrefix}-visibility-ceiling`}
          >
            <Text size="sm">{ceilingReason}</Text>
          </Alert>
        ) : null}

        <Radio.Group
          value={choice}
          onChange={setChoice}
          data-testid={`${testIdPrefix}-visibility-options`}
        >
          <Stack gap="xs" mt="xs">
            {options.map((o) => (
              <Radio
                key={o.value}
                value={o.value}
                label={o.label}
                description={o.enabled ? o.description : `${o.description} — ${o.disabledReason}`}
                disabled={!available || !o.enabled || mutation.isPending}
                data-testid={`${testIdPrefix}-visibility-option-${o.value}`}
              />
            ))}
          </Stack>
        </Radio.Group>

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              // Guarded by `disabled` as well; re-checked here so a programmatic click
              // cannot send an empty or above-ceiling value.
              if (!isAppListingVisibility(choice)) return;
              mutation.mutate({ listingId: target.id, visibility: choice });
            }}
            loading={mutation.isPending}
            disabled={!available || !dirty || !chosenIsSettable || mutation.isPending}
            data-testid={`${testIdPrefix}-visibility-save`}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
