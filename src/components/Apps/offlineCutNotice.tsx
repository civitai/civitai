import { Button, Stack, Text } from '@mantine/core';

import {
  offlineCutFailureNotice,
  type ModerationHistoryTarget,
} from '~/components/Apps/appListingModerationView';
import { openListingModerationHistory } from '~/components/Apps/ListingModerationHistoryModal';
import { showWarningNotification } from '~/utils/notifications';

/** The toast body: the warning, and a button opening the taken-down listing's history. */
export function OfflineCutNoticeMessage({
  message,
  historyFor,
}: {
  message: string;
  historyFor: ModerationHistoryTarget;
}) {
  return (
    <Stack gap={6}>
      <Text size="sm">{message}</Text>
      <Button
        size="compact-xs"
        variant="light"
        color="orange"
        onClick={() => openListingModerationHistory(historyFor)}
        data-testid="apps-offline-cut-open-history"
      >
        Open moderation history
      </Button>
    </Stack>
  );
}

/**
 * After a takedown (`delistListing`): warn the moderator when the connect app's offline-access cut
 * was attempted and failed, with a button that opens that listing's moderation history, where
 * "Retry cut" lives. Shows nothing otherwise, including whenever the flag is off. Every delist
 * call site calls this with the listing it took down.
 */
export function showOfflineCutFailureWarning(
  result: unknown,
  listing: ModerationHistoryTarget
): void {
  const notice = offlineCutFailureNotice(result, listing);
  if (!notice) return;
  showWarningNotification({
    title: notice.title,
    message: <OfflineCutNoticeMessage message={notice.message} historyFor={notice.historyFor} />,
    autoClose: false,
  });
}
