import { Alert, Button, Modal, Radio, Stack, Text, Textarea } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAlertTriangle, IconFlag } from '@tabler/icons-react';
import { type ChangeEvent, useState } from 'react';

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
 */

export function ReportListingButton({ appListingId }: { appListingId: string }) {
  const currentUser = useCurrentUser();
  const [opened, { open, close }] = useDisclosure(false);
  const [reason, setReason] = useState<AppListingReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const reportMutation = trpc.appListings.reportListing.useMutation({
    onSuccess: () => {
      setDone(true);
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

  // The report proc is protected — never offer it to a signed-out viewer.
  if (!currentUser) return null;

  const reset = () => {
    setReason(null);
    setDetails('');
    setInlineError(null);
  };

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
      <Button
        variant="subtle"
        color="gray"
        size="xs"
        leftSection={<IconFlag size={14} />}
        onClick={() => {
          reset();
          open();
        }}
        disabled={done}
      >
        {done ? 'Reported' : 'Report'}
      </Button>

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
