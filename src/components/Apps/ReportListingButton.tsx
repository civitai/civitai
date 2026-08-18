import { Alert, Button, Modal, Radio, Stack, Text, Textarea } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAlertTriangle, IconFlag } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import {
  APP_LISTING_REPORT_REASON_OPTIONS,
  isReportReason,
  reportErrorMessage,
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
 * A small "Report" button that opens a modal with a reason picker (the 6 schema
 * reasons, human-labelled via the pure `appListingReportView` helper) + an
 * optional details textarea → `trpc.appListings.reportListing`. The reporter is
 * bound server-side to the authenticated caller (IDOR-safe); the DB partial-unique
 * dedups a duplicate open report, surfaced inline as a friendly "already reported"
 * message (mapped by `reportErrorMessage`).
 *
 * DARK: rendered only where the listing detail is visible — the mod-only
 * `/apps/store-preview/<slug>` surface today — so reports are effectively mod-only
 * until the store widens. Hidden entirely for a signed-out viewer (the proc is
 * `protectedProcedure`).
 *
 * 🔴 SPLIT INTO GATE + MODAL + BUTTON for the same structural reason as
 * `ReviewListingButton` — see that file's header. Short version: the listing detail's
 * secondary actions moved into a `⋮` Menu, a Mantine `Menu.Dropdown` UNMOUNTS on
 * close, and a modal rendered as a sibling of a `Menu.Item` trigger would therefore
 * be destroyed by the very click meant to open it. The trigger goes inside the
 * dropdown, the modal outside, so `opened` has to be the caller's state.
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
 * `onReported` fires once the mutation succeeds, so a caller can mark its own trigger
 * as spent (the standalone Button below disables itself and reads "Reported").
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

  // Clear the form on every OPEN. The standalone Button used to do this in its own
  // click handler (`reset(); open();`); with the trigger now living outside this
  // component, the reset has to key on the transition instead so BOTH triggers get it.
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

/**
 * The standalone report affordance: gate + a small Button + the modal.
 *
 * UNCHANGED public API and unchanged behaviour — composed from the two exports above
 * rather than inlining them. `ReportListingButton.browser.test.tsx` is the guard.
 */
export function ReportListingButton({ appListingId }: { appListingId: string }) {
  const canReport = useCanReportListing();
  const [opened, { open, close }] = useDisclosure(false);
  const [done, setDone] = useState(false);

  // The report proc is protected — never offer it to a signed-out viewer.
  if (!canReport) return null;

  return (
    <>
      <Button
        variant="subtle"
        color="gray"
        size="xs"
        leftSection={<IconFlag size={14} />}
        onClick={open}
        disabled={done}
      >
        {done ? 'Reported' : 'Report'}
      </Button>
      <ReportListingModal
        appListingId={appListingId}
        opened={opened}
        onClose={close}
        onReported={() => setDone(true)}
      />
    </>
  );
}
