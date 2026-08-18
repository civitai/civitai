import { Alert, Button, Modal, Radio, Stack, Text, Textarea } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAlertTriangle, IconFlag } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import {
  APP_LISTING_REPORT_REASON_OPTIONS,
  isReportReason,
  reportErrorMessage,
  reportTriggerState,
} from '~/components/Apps/appListingReportView';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  type AppListingReportReason,
  OFFSITE_REPORT_DETAILS_MAX,
} from '~/server/schema/blocks/offsite-moderation.schema';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * App Store Listings (W13) — P3b USER REPORT affordance for an off-site listing.
 *
 * A "Report" trigger (today the `⋮` menu item on the listing detail page) opens a
 * modal with a reason picker (the 6 schema reasons, human-labelled via the pure
 * `appListingReportView` helper) + an optional details textarea →
 * `trpc.appListings.reportListing`. The reporter is
 * bound server-side to the authenticated caller (IDOR-safe); the DB partial-unique
 * dedups a duplicate open report, surfaced inline as a friendly "already reported"
 * message (mapped by `reportErrorMessage`).
 *
 * DARK: rendered only where the listing detail is visible — the mod-only
 * `/apps/store-preview/<slug>` surface today — so reports are effectively mod-only
 * until the store widens. Hidden entirely for a signed-out viewer (the proc is
 * `protectedProcedure`).
 *
 * 🔴 SPLIT INTO GATE + STATE HOOK + MODAL for the same structural reason as
 * `ReviewListingButton` — see that file's header. Short version: the listing detail's
 * secondary actions moved into a `⋮` Menu, a Mantine `Menu.Dropdown` UNMOUNTS on
 * close, and a modal rendered as a sibling of a `Menu.Item` trigger would therefore
 * be destroyed by the very click meant to open it. The trigger goes inside the
 * dropdown, the modal outside, so `opened` has to be the caller's state.
 *
 * 🔴 WHICH IS EXACTLY HOW THE "ALREADY REPORTED" GUARD WENT MISSING. This file used
 * to ALSO export a self-contained `ReportListingButton` that owned a local
 * `done` flag, disabled its own trigger and read "Reported" once the mutation
 * succeeded. Nothing ever rendered it — the live detail page mounted the modal
 * itself and never passed `onReported` — so the guard sat in dead code while the
 * real `⋮` menu item stayed live, and a second report attempt hit the server's
 * one-open-report-per-reporter CONFLICT and surfaced an ERROR instead of the
 * "Reported" state. The button is gone; the state it owned now lives in
 * {@link useReportListingAffordance}, which hands the caller BOTH halves as
 * pre-wired prop bags so a trigger cannot be mounted without its `onReported`.
 */

/**
 * May THIS viewer report a listing? Signed-in only — `reportListing` is a
 * `protectedProcedure`, so a signed-out viewer must never be offered the affordance.
 *
 * 🔴 Deliberately NOT owner-gated, unlike {@link useCanReviewListing}. Reporting your
 * own listing is pointless but harmless; hiding it would be a new policy, and this
 * change ports a layout, not the moderation rules.
 */
export function useCanReportListing(): boolean {
  return !!useCurrentUser();
}

/**
 * The report form modal. Renders NO trigger — the caller owns `opened`.
 *
 * `onReported` fires once the mutation succeeds, so the caller can mark its own trigger
 * as spent. Callers get that wiring from {@link useReportListingAffordance} rather than
 * assembling it by hand — see its comment for why the prop bags exist.
 */
export function ReportListingModal({
  appListingId,
  opened,
  onClose,
  onReported,
}: {
  appListingId: string;
  opened: boolean;
  onClose: () => void;
  onReported?: () => void;
}) {
  const [reason, setReason] = useState<AppListingReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const close = onClose;

  const reportMutation = trpc.appListings.reportListing.useMutation({
    onSuccess: () => {
      onReported?.();
      setInlineError(null);
      showSuccessNotification({
        title: 'Report submitted',
        message: 'Thanks — a moderator will review this app.',
      });
      close();
    },
    onError: (error: { data?: { code?: string | null } | null; message?: string | null }) => {
      setInlineError(reportErrorMessage(error));
    },
  });

  const reset = () => {
    setReason(null);
    setDetails('');
    setInlineError(null);
  };

  // Clear the form on every OPEN. The retired standalone button used to do this in its
  // own click handler (`reset(); open();`); with the trigger living outside this
  // component, the reset keys on the transition instead so every trigger gets it.
  useEffect(() => {
    if (opened) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const handleClose = () => {
    if (reportMutation.isPending) return;
    close();
    reset();
  };

  const handleSubmit = () => {
    setInlineError(null);
    if (!reason) {
      setInlineError('Please choose a reason.');
      return;
    }
    reportMutation.mutate({
      appListingId,
      reason,
      details: details.trim() ? details.trim() : undefined,
    });
  };

  return (
    <>
      <Modal opened={opened} onClose={handleClose} title="Report this app" size="md" centered>
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Tell us what&apos;s wrong with this app. Reports go to the Civitai moderation team.
          </Text>

          <Radio.Group
            label="Reason"
            value={reason ?? ''}
            onChange={(value: string) => setReason(isReportReason(value) ? value : null)}
            withAsterisk
          >
            <Stack gap="xs" mt="xs">
              {APP_LISTING_REPORT_REASON_OPTIONS.map((opt) => (
                <Radio key={opt.value} value={opt.value} label={opt.label} />
              ))}
            </Stack>
          </Radio.Group>

          <Textarea
            label="Details (optional)"
            placeholder="Add any context that will help a moderator."
            value={details}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDetails(e.currentTarget.value)}
            maxLength={OFFSITE_REPORT_DETAILS_MAX}
            autosize
            minRows={3}
            maxRows={6}
          />

          {inlineError && (
            <Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />}>
              {inlineError}
            </Alert>
          )}

          <Button
            onClick={handleSubmit}
            loading={reportMutation.isPending}
            leftSection={<IconFlag size={16} />}
          >
            Submit report
          </Button>
        </Stack>
      </Modal>
    </>
  );
}

export type ReportListingAffordance = {
  /** Trigger copy — "Report", or "Reported" once this viewer has reported. */
  label: string;
  /** Has this viewer already reported the listing IN THIS SESSION? */
  reported: boolean;
  /** Spread onto the trigger (a `Menu.Item`, a `Button`, …). */
  triggerProps: { disabled: boolean; onClick: () => void };
  /** Spread onto {@link ReportListingModal}. Carries the `onReported` wiring. */
  modalProps: { opened: boolean; onClose: () => void; onReported: () => void };
};

/**
 * The report affordance's STATE, owned in one place: disclosure + the spent flag.
 *
 * 🔴 THE POINT OF THE PROP BAGS is that they cannot be half-wired. The server allows
 * one open report per reporter, so a second attempt is a CONFLICT — a friendly error,
 * but an error, where the user expects a confirmation. The only way to keep that off
 * the screen is for the trigger that opened the modal to go disabled when the modal
 * reports success, and the two live in different subtrees (see the header: the
 * trigger is inside a `Menu.Dropdown` that unmounts, the modal is outside it). A
 * caller that spreads `triggerProps` and `modalProps` gets that link for free; a
 * caller that hand-rolls either half is what shipped the bug. `disabled` / `label`
 * come from the pure {@link reportTriggerState} so the rule has exactly one
 * definition, and it is pinned in the blocking node `unit` project
 * (`__tests__/appListingReportView.test.ts` for the rule,
 * `__tests__/appListingReportCallSites.test.ts` for the wiring).
 */
export function useReportListingAffordance(): ReportListingAffordance {
  const [opened, { open, close }] = useDisclosure(false);
  const [reported, setReported] = useState(false);
  const { label, disabled } = reportTriggerState(reported);

  return {
    label,
    reported,
    triggerProps: { disabled, onClick: open },
    modalProps: { opened, onClose: close, onReported: () => setReported(true) },
  };
}
