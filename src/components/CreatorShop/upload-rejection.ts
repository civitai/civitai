import type { FileRejection } from '@mantine/dropzone';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';

/**
 * Mantine's Dropzone routes a file failing `maxSize` or `accept` to `onReject` and never
 * calls `onDrop`. Both CreatorShop pickers used to leave `onReject` unset, so an oversized
 * pick did nothing at all — no upload, no message, no change on screen. That is how a 2 MB
 * cap on pack covers reached a bug report as "animated covers don't animate" (868kz1hnq):
 * the file was never uploaded, so the card kept showing whatever was there before.
 *
 * The size check inside `validateCosmeticImage` cannot cover this — it runs from `onDrop`,
 * which a rejected file never reaches.
 */
export function notifyUploadRejection(rejections: FileRejection[], maxSize: number) {
  const rejection = rejections[0];
  if (!rejection) return;

  const tooBig = rejection.errors.some((error) => error.code === 'file-too-large');
  const wrongType = rejection.errors.some((error) => error.code === 'file-invalid-type');

  const reason = tooBig
    ? `That file is ${formatBytes(rejection.file.size)}. The limit is ${formatBytes(maxSize)}.`
    : wrongType
    ? 'That file type is not accepted here.'
    : rejection.errors.map((error) => error.message).join('\n');

  showErrorNotification({
    title: "That file wasn't accepted",
    error: new Error(reason),
  });
}
