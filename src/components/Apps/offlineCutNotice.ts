import { offlineCutFailureWarning } from '~/components/Apps/appListingModerationView';
import { showWarningNotification } from '~/utils/notifications';

/**
 * After a takedown (`delistListing`): warn the moderator when the connect app's offline-access cut
 * was attempted and failed. Shows nothing otherwise, including whenever the flag is off. Every
 * delist call site calls this, so the warning reads the same wherever the takedown started.
 */
export function showOfflineCutFailureWarning(result: unknown): void {
  const message = offlineCutFailureWarning(result);
  if (!message) return;
  showWarningNotification({ title: 'Offline access not cut', message, autoClose: false });
}
