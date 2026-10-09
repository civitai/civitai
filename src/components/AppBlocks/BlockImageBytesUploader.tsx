import { useEffect, useRef } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { trpc } from '~/utils/trpc';
import { extractErrorMessage } from './blockImageScanLogic';

/**
 * Headless, host-mounted runner for one `OPEN_IMAGE_UPLOAD { bytes }` request: the picker modal's
 * upload → persist steps (`BlockImageUploadModal.handleFile`) with the block's bytes in place of a
 * picked file, persisted through `blocks.persistAppUploadImage` so the row carries the app's
 * upload stamp. The scan wait is NOT here: the host hands the persisted id to a
 * `BlockImageScanPoller`, the same one the async picker uses.
 *
 * Starts once per mount. Not cancelled on unmount — React's dev double-invoke would otherwise
 * drop the only run — so a late callback after the host has gone posts into a removed frame,
 * which is harmless.
 */
export function BlockImageBytesUploader({
  bytes,
  filename,
  contentType,
  blockToken,
  onPersisted,
  onError,
}: {
  bytes: ArrayBuffer;
  filename: string;
  contentType: string;
  blockToken: string;
  onPersisted: (handle: { imageId: number; url: string }) => void;
  onError: (message: string) => void;
}) {
  const { uploadToCF } = useCFImageUpload();
  const persistMutation = trpc.blocks.persistAppUploadImage.useMutation();

  const latest = useRef({ uploadToCF, persist: persistMutation.mutateAsync, onPersisted, onError });
  latest.current = { uploadToCF, persist: persistMutation.mutateAsync, onPersisted, onError };
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        const file = new File([bytes], filename, { type: contentType });
        const uploaded = await latest.current.uploadToCF(file);
        const { imageId } = await latest.current.persist({
          blockToken,
          url: uploaded.id,
          name: filename,
        });
        latest.current.onPersisted({ imageId, url: getEdgeUrl(uploaded.id, { width: 1200 }) });
      } catch (err) {
        latest.current.onError(extractErrorMessage(err) ?? 'image upload failed');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one upload per mount; the request is immutable.
  }, []);

  return null;
}
