import { Alert, Badge, Button, FileInput, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconSchool, IconUpload } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useSignInToUpload } from '~/components/Login/useSignInToUpload';
import { BLOCK_TRAINING_DATASET_MAX_ITEMS } from '~/server/schema/blocks/training-dataset.schema';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { uploadTrainingDataImage, type TrainingDataUpload } from './trainingDataUpload';

/**
 * App Blocks — the host modal behind PageBlockHost's `OPEN_IMAGE_UPLOAD` bridge when a
 * block requests `purpose: 'trainingData'`: up to `BLOCK_TRAINING_DATASET_MAX_ITEMS`
 * images uploaded as consumer blobs, the Training Studio's own upload path. Resolves
 * with every image that uploaded; the host remembers those keys for this block.
 */

const UPLOAD_CONCURRENCY = 3;

type UploadStatus = 'idle' | 'uploading' | 'done';

export default function BlockTrainingDataUploadModal({
  onResolved,
}: {
  /** Called ONCE with the uploaded images when the viewer finishes. */
  onResolved: (images: TrainingDataUpload[]) => void;
}) {
  const dialog = useDialogContext();
  const { requireSignIn } = useSignInToUpload();
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [uploaded, setUploaded] = useState<TrainingDataUpload[]>([]);
  const [failed, setFailed] = useState(0);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  // A batch that lands after the modal closed must not resolve anything.
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  function finish(images: TrainingDataUpload[]) {
    onResolved(images);
    dialog.onClose();
  }

  async function handleFiles(picked: File[]) {
    if (picked.length === 0 || requireSignIn()) return;
    const files = picked.slice(0, BLOCK_TRAINING_DATASET_MAX_ITEMS);
    setMessage(
      picked.length > files.length
        ? `Only the first ${BLOCK_TRAINING_DATASET_MAX_ITEMS} images are used.`
        : null
    );
    setStatus('uploading');
    setTotal(files.length);
    setUploaded([]);
    setFailed(0);

    const results: Array<TrainingDataUpload | null> = new Array(files.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < files.length && liveRef.current) {
        const index = next++;
        try {
          results[index] = await uploadTrainingDataImage(files[index]);
          if (liveRef.current)
            setUploaded((prev) => [...prev, results[index] as TrainingDataUpload]);
        } catch {
          if (liveRef.current) setFailed((n) => n + 1);
        }
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
    if (!liveRef.current) return;

    const images = results.filter((r): r is TrainingDataUpload => r !== null);
    setStatus('done');
    if (images.length === files.length) finish(images);
  }

  const busy = status === 'uploading';

  return (
    <Modal {...dialog} withCloseButton title="Upload training images">
      <Stack gap="md">
        <Alert color="blue" variant="light" icon={<IconSchool size={16} />}>
          <Text size="sm">
            These images are <strong>private training data</strong> — they aren&apos;t published.
            Upload up to {BLOCK_TRAINING_DATASET_MAX_ITEMS} PNG, JPEG or WebP images.
          </Text>
        </Alert>

        <FileInput
          label="Training images"
          placeholder="Select images"
          accept={IMAGE_MIME_TYPE.join(',')}
          multiple
          disabled={busy}
          leftSection={<IconUpload size={16} />}
          value={[]}
          onChange={(files: File[]) => void handleFiles(files)}
          data-testid="block-training-data-file-input"
        />

        {status !== 'idle' && (
          <Group gap={8} data-testid="block-training-data-progress">
            {busy ? (
              <Badge size="xs" color="blue" leftSection={<Loader size={10} color="blue" />}>
                uploading {uploaded.length + failed} of {total}
              </Badge>
            ) : (
              <Badge size="xs" color="green" leftSection={<IconCheck size={10} />}>
                {uploaded.length} uploaded
              </Badge>
            )}
            {failed > 0 && (
              <Badge size="xs" color="red" leftSection={<IconAlertTriangle size={10} />}>
                {failed} failed
              </Badge>
            )}
          </Group>
        )}

        {message && (
          <Text size="xs" c="dimmed">
            {message}
          </Text>
        )}

        <Group justify="flex-end" gap="xs">
          <Button size="xs" variant="default" onClick={dialog.onClose} disabled={busy}>
            Cancel
          </Button>
          {status === 'done' && uploaded.length > 0 && (
            <Button size="xs" onClick={() => finish(uploaded)}>
              Use {uploaded.length} image{uploaded.length === 1 ? '' : 's'}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
