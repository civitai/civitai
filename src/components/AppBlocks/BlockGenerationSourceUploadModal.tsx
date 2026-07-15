import { Alert, Badge, Button, FileInput, Group, Image, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconBolt, IconCheck, IconUpload } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';
import { getImageDimensions } from '~/utils/image-utils';

/**
 * App Blocks — the host modal behind PageBlockHost's `OPEN_IMAGE_UPLOAD` bridge
 * when a block requests `purpose: 'generationSource'`. Unlike the moderated
 * `display` path (BlockImageUploadModal), this uploads a PRIVATE generation
 * INPUT (an img2img source image), NOT a publicly-displayed image.
 *
 * It therefore reuses the SAME lightweight consumer-blob util civitai's own
 * generator uses for a source image (`uploadConsumerBlob`, see
 * `SourceImageUpload`): a presigned PUT to the orchestrator's consumer-blob
 * store. There is deliberately NO `createImage` / `ingestImage`, NO public-image
 * scan, NO SFW ceiling / flag gate, and NO `imageId` / `nsfwLevel` — the result
 * is only `{ url, width, height }`. Platform safety is preserved because the
 * ORCHESTRATOR auto-scans the generation OUTPUT, exactly as it does for the
 * generator's own img2img sources.
 *
 * The blob resolves to an `https://orchestration…civitai.com` URL whose hostname
 * ends in `.civitai.com`, so the returned url passes the img2img
 * `blockSourceImageSchema` host allowlist (workflow.schema) unchanged — no
 * loosening of that allowlist is required.
 */

export type BlockSourceImageInfo = { url: string; width: number; height: number };

type UploadStatus = 'idle' | 'uploading' | 'ready' | 'error';

export default function BlockGenerationSourceUploadModal({
  onResolved,
}: {
  /** Called ONCE with the source projection when the consumer blob lands. */
  onResolved: (result: BlockSourceImageInfo) => void;
}) {
  const dialog = useDialogContext();
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Guard against a resolved upload landing after the modal unmounts / a new
  // upload supersedes it (epoch bump) — and clean up the object-URL preview.
  const epochRef = useRef(0);
  const objectUrlRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  async function handleFile(file: File | null) {
    if (!file) return;
    const epoch = ++epochRef.current;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const localPreview = URL.createObjectURL(file);
    objectUrlRef.current = localPreview;
    setPreviewUrl(localPreview);
    setStatus('uploading');
    setMessage(null);
    try {
      // The SAME util the generator's SourceImageUpload uses: a presigned PUT to
      // the orchestrator consumer-blob store. NO createImage, NO scan, NO gate.
      const blob = await uploadConsumerBlob(file);
      if (epoch !== epochRef.current) return;
      if (!blob.url) throw new Error('Upload did not return a URL');
      // Real dimensions from the uploaded blob (mirrors SourceImageUpload).
      const { width, height } = await getImageDimensions(blob.url);
      if (epoch !== epochRef.current) return;
      setStatus('ready');
      setMessage(null);
      onResolved({ url: blob.url, width, height });
      dialog.onClose();
    } catch (err) {
      if (epoch !== epochRef.current) return;
      setStatus('error');
      setMessage((err as Error).message);
    }
  }

  const busy = status === 'uploading';

  return (
    <Modal {...dialog} withCloseButton title="Upload a source image">
      <Stack gap="md">
        <Alert color="blue" variant="light" icon={<IconBolt size={16} />}>
          <Text size="sm">
            This image is a <strong>private generation input</strong> — it isn&apos;t published.
            Upload a PNG, JPEG or WebP.
          </Text>
        </Alert>

        {previewUrl && (
          <Image
            src={previewUrl}
            radius="sm"
            fit="contain"
            mah={220}
            alt="source image preview"
            data-testid="block-generation-source-preview"
          />
        )}

        <Group gap={8}>
          <StatusBadge status={status} />
        </Group>

        <FileInput
          label="Source image"
          placeholder="Select an image"
          accept="image/png,image/jpeg,image/webp"
          clearable
          disabled={busy}
          leftSection={<IconUpload size={16} />}
          value={null}
          onChange={(f: File | null) => void handleFile(f)}
          data-testid="block-generation-source-file-input"
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
