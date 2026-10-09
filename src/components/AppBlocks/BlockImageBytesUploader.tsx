import { useEffect, useRef } from 'react';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { trpc } from '~/utils/trpc';
import { extractErrorMessage } from './blockImageScanLogic';

/**
 * Headless runner for one `OPEN_IMAGE_UPLOAD { bytes }` request: `BlockImageUploadModal.handleFile`'s
 * upload → persist with the block's bytes in place of a picked file, preceded by
 * `blocks.authorizeAppUploadImage`, which applies the persist's gates and takes the upload's
 * rate-limit charge before any bytes are stored.
 *
 * Deliberately not cancelled on unmount: with React's dev double-invoke, a cancel would drop the
 * only run. A late callback posts into a removed frame, which is harmless.
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
  onPersisted: (imageId: number) => void;
  onError: (message: string) => void;
}) {
  const { uploadToCF } = useCFImageUpload();
  const authorizeMutation = trpc.blocks.authorizeAppUploadImage.useMutation();
  const persistMutation = trpc.blocks.persistAppUploadImage.useMutation();

  const latest = useRef({
    uploadToCF,
    authorize: authorizeMutation.mutateAsync,
    persist: persistMutation.mutateAsync,
    onPersisted,
    onError,
  });
  latest.current = {
    uploadToCF,
    authorize: authorizeMutation.mutateAsync,
    persist: persistMutation.mutateAsync,
    onPersisted,
    onError,
  };
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      let objectUrl: string | undefined;
      try {
        await latest.current.authorize({ blockToken });
        const file = new File([bytes], filename, { type: contentType });
        const uploaded = await latest.current.uploadToCF(file);
        // The upload hook mints a preview object URL nobody here displays; left alive it pins an
        // in-memory copy of the file for the life of the page.
        objectUrl = uploaded.objectUrl;
        const { imageId } = await latest.current.persist({
          blockToken,
          url: uploaded.id,
          name: filename,
        });
        latest.current.onPersisted(imageId);
      } catch (err) {
        latest.current.onError(extractErrorMessage(err) ?? 'image upload failed');
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one upload per mount; the request is immutable.
  }, []);

  return null;
}
