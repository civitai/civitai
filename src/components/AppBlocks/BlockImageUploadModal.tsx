import { Alert, Badge, Button, FileInput, Group, Image, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconPhoto, IconUpload } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { nextPollDelay } from '~/components/Apps/assetPolling';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { OffsiteRatingValue } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';

/**
 * App Blocks (Phase-2a PR-C) — the host modal behind PageBlockHost's
 * `OPEN_IMAGE_UPLOAD` bridge. A sandboxed block asks the host to let the user
 * upload an image (the app decides what it is for — avatar / cover / background /
 * reference / …); the bytes flow through civitai's OWN session-authed upload path
 * (the iframe never touches them), the REAL scan runs, and only a MODERATED,
 * SFW-clean, unflagged image id is handed back.
 *
 * Flow (mirrors the app-listing asset step, single image):
 *   uploadToCF → blockImageUpload.persist (createImage + real ingestImage) → poll
 *   blockImageUpload.gate until `{ status: 'ready' }` (scanned + within the SFW
 *   ceiling + unflagged) or a THROWN terminal error (scan-blocked / above-SFW /
 *   flagged / import-failed → stop, show message). On ready we call `onResolved`
 *   with the MINIMAL public projection and close; the host posts IMAGE_UPLOAD_RESULT.
 *   If the user closes without a successful upload, the host posts a bare
 *   (cancelled) result — see the OPEN_IMAGE_UPLOAD handler's `options.onClose`.
 *
 * ASYNC (non-blocking) mode — when the caller passes `onAccepted`: the modal
 * resolves the INSTANT the image is PERSISTED (imageId known, scan still
 * in-flight) and SKIPS the in-modal poll gate entirely. It hands back a pending
 * handle `{ imageId, url }` (the author's OWN just-uploaded edge URL — an
 * unguessable UUID key, author-preview-only) and closes. The scan verdict is
 * then streamed to the block asynchronously by a HOST-mounted poller
 * (`BlockImageScanPoller`) that survives this modal's unmount — see PageBlockHost's
 * OPEN_IMAGE_UPLOAD handler. The authoritative server gate is UNCHANGED: the
 * pending handle exposes only the author's own preview URL, and no cross-user
 * surface persists the image until the async verdict is `scanned`.
 */

export type BlockUploadedImageInfo = {
  imageId: number;
  nsfwLevel: number;
  contentRating: OffsiteRatingValue;
  url: string;
};

type UploadStatus = 'idle' | 'uploading' | 'scanning' | 'ready' | 'error';

async function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

export default function BlockImageUploadModal({
  onResolved,
  onAccepted,
}: {
  /** Called ONCE with the moderated result when a clean+SFW+unflagged image lands.
   *  BLOCKING mode only (ignored when `onAccepted` is provided). */
  onResolved: (result: BlockUploadedImageInfo) => void;
  /** ASYNC (non-blocking) mode. When provided, the modal resolves EARLY — the
   *  instant the image is persisted (imageId known) — with a pending handle and
   *  closes, SKIPPING the in-modal poll gate. The scan verdict is streamed later
   *  by a host-mounted poller. The `url` is the author's OWN just-uploaded edge
   *  URL (unguessable UUID key), for author preview only. */
  onAccepted?: (handle: { imageId: number; url: string }) => void;
}) {
  const dialog = useDialogContext();
  const { uploadToCF } = useCFImageUpload();
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const persistMutation = trpc.blockImageUpload.persist.useMutation();
  const gateMutation = trpc.blockImageUpload.gate.useMutation();

  // Guard against a resolved poll landing after the modal unmounts / a new upload
  // supersedes it (epoch bump) — and clean up the object-URL preview + timer.
  const epochRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  function clearTimer() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }
  useEffect(() => {
    return () => {
      clearTimer();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  async function pollGate(imageId: number, attempt: number, epoch: number) {
    let ready: BlockUploadedImageInfo | null = null;
    try {
      const res = await gateMutation.mutateAsync({ imageId });
      if (epoch !== epochRef.current) return;
      if (res.status === 'ready') {
        ready = {
          imageId: res.imageId,
          nsfwLevel: res.nsfwLevel,
          contentRating: res.contentRating,
          url: res.url,
        };
      }
    } catch (err) {
      // A THROWN error is terminal (scan-blocked / above-SFW / flagged / import-failed).
      if (epoch !== epochRef.current) return;
      clearTimer();
      setStatus('error');
      setMessage((err as Error).message);
      return;
    }
    if (ready) {
      clearTimer();
      setStatus('ready');
      setMessage(null);
      onResolved(ready);
      dialog.onClose();
      return;
    }
    // Still scanning — schedule the next poll while budget remains.
    const delayMs = nextPollDelay(attempt);
    if (delayMs === null) {
      clearTimer();
      setStatus('error');
      setMessage('Still scanning — please try again in a moment.');
      return;
    }
    setStatus('scanning');
    timerRef.current = setTimeout(() => void pollGate(imageId, attempt + 1, epoch), delayMs);
  }

  async function handleFile(file: File | null) {
    if (!file) return;
    clearTimer();
    const epoch = ++epochRef.current;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const localPreview = URL.createObjectURL(file);
    objectUrlRef.current = localPreview;
    setPreviewUrl(localPreview);
    setStatus('uploading');
    setMessage(null);
    try {
      const { width, height } = await readImageDimensions(file);
      const uploaded = await uploadToCF(file);
      if (epoch !== epochRef.current) return;
      const { imageId } = await persistMutation.mutateAsync({
        url: uploaded.id,
        name: file.name,
        width,
        height,
        mimeType: file.type || undefined,
        sizeBytes: file.size,
      });
      if (epoch !== epochRef.current) return;
      // ASYNC (non-blocking) mode: the caller wants the modal to resolve the
      // instant the image is persisted (imageId known) and to stream the scan
      // verdict itself via a host-mounted poller. Compute the author's preview
      // URL with the SAME edge transform the server gate uses (uploaded.id is the
      // CF key), hand back the pending handle, and close — SKIP the poll gate.
      if (onAccepted) {
        const url = getEdgeUrl(uploaded.id, { width: 1200 });
        onAccepted({ imageId, url });
        dialog.onClose();
        return;
      }
      await pollGate(imageId, 0, epoch);
    } catch (err) {
      if (epoch !== epochRef.current) return;
      clearTimer();
      setStatus('error');
      setMessage((err as Error).message);
    }
  }

  const busy = status === 'uploading' || status === 'scanning';

  return (
    <Modal {...dialog} withCloseButton title="Upload an image">
      <Stack gap="md">
        <Alert color="blue" variant="light" icon={<IconPhoto size={16} />}>
          <Text size="sm">
            This image is <strong>public</strong>, so it&apos;s scanned and must be
            safe-for-work. Upload a PNG, JPEG or WebP.
          </Text>
        </Alert>

        {previewUrl && (
          <Image
            src={previewUrl}
            radius="sm"
            fit="contain"
            mah={220}
            alt="image preview"
            data-testid="block-image-upload-preview"
          />
        )}

        <Group gap={8}>
          <StatusBadge status={status} />
        </Group>

        <FileInput
          label="Image"
          placeholder="Select an image"
          accept="image/png,image/jpeg,image/webp"
          clearable
          disabled={busy}
          leftSection={<IconUpload size={16} />}
          value={null}
          onChange={(f: File | null) => void handleFile(f)}
          data-testid="block-image-upload-file-input"
        />

        {message && (
          <Text size="xs" c={status === 'error' ? 'red' : 'dimmed'}>
            {message}
          </Text>
        )}

        <Group justify="flex-end" gap="xs">
          <Button size="xs" variant="default" onClick={dialog.onClose} disabled={busy}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function StatusBadge({ status }: { status: UploadStatus }) {
  switch (status) {
    case 'uploading':
      return (
        <Badge size="xs" color="blue" leftSection={<Loader size={10} color="blue" />}>
          uploading…
        </Badge>
      );
    case 'scanning':
      return (
        <Badge size="xs" color="yellow" leftSection={<Loader size={10} color="yellow" />}>
          scanning image…
        </Badge>
      );
    case 'ready':
      return (
        <Badge size="xs" color="green" leftSection={<IconCheck size={10} />}>
          ready
        </Badge>
      );
    case 'error':
      return (
        <Badge size="xs" color="red" leftSection={<IconAlertTriangle size={10} />}>
          error
        </Badge>
      );
    default:
      return (
        <Text size="xs" c="dimmed">
          no image selected
        </Text>
      );
  }
}
