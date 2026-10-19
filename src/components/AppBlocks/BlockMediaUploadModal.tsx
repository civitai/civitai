import { Alert, Badge, Button, FileInput, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconBolt, IconCheck, IconUpload } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { UnreadablePickAlert } from '~/components/ImageUpload/UnreadablePickAlert';
import { useSignInToUpload } from '~/components/Login/useSignInToUpload';
import { reportUnreadablePick, snapshotPick } from '~/utils/unreadable-pick';
import {
  checkMediaFile,
  MEDIA_UPLOAD_ACCEPT,
  MEDIA_UPLOAD_MAX_BYTES_BY_KIND,
  type BlockMediaUploadInfo,
  type MediaUploadKind,
} from './mediaUploadLogic';
import { mediaUploadErrorMessage, uploadGenerationMedia } from './mediaUploadRun';

const COPY: Record<MediaUploadKind, { title: string; label: string; types: string }> = {
  image: { title: 'Upload an image', label: 'Image', types: 'a PNG, JPEG or WebP image' },
  video: { title: 'Upload a video', label: 'Video', types: 'an MP4 or WebM video' },
  audio: { title: 'Upload audio', label: 'Audio', types: 'an MP3, WAV or WebM audio file' },
};

type UploadStatus = 'idle' | 'uploading' | 'ready' | 'error';

/**
 * Host chrome behind `OPEN_MEDIA_UPLOAD` without `bytes`: the viewer picks a file of the requested
 * kind and it is uploaded as a PRIVATE generation input (an orchestrator consumer blob). Nothing
 * is published, so there is no Image row and no public scan; the orchestrator scans the output.
 */
export default function BlockMediaUploadModal({
  kind,
  onResolved,
}: {
  kind: MediaUploadKind;
  /** Called once, with the upload, before the modal closes itself. */
  onResolved: (result: BlockMediaUploadInfo) => void;
}) {
  const dialog = useDialogContext();
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [unreadablePick, setUnreadablePick] = useState(false);
  const { requireSignIn } = useSignInToUpload();
  const copy = COPY[kind];
  const accept = MEDIA_UPLOAD_ACCEPT[kind];

  // A late upload must not resolve a modal that unmounted or was superseded by a newer pick.
  const epochRef = useRef(0);
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the live epoch counter, not a DOM node
      epochRef.current++;
    };
  }, []);

  async function handleFile(picked: File | null) {
    if (!picked || requireSignIn()) return;
    const epoch = ++epochRef.current;
    setMessage(null);
    setUnreadablePick(false);
    setStatus('uploading');
    try {
      const { file, error } = await snapshotPick(picked, {
        maxBytes: MEDIA_UPLOAD_MAX_BYTES_BY_KIND[kind],
      });
      if (epoch !== epochRef.current) return;
      if (error) {
        reportUnreadablePick(picked, 'app-block-media-upload');
        setStatus('idle');
        setUnreadablePick(true);
        return;
      }
      const checked = checkMediaFile(kind, file.size, await file.slice(0, 64).arrayBuffer());
      if (epoch !== epochRef.current) return;
      if (!checked.ok) {
        setStatus('error');
        setMessage(checked.error);
        return;
      }
      const result = await uploadGenerationMedia(
        kind,
        file,
        checked.contentType,
        () => epoch === epochRef.current
      );
      if (!result || epoch !== epochRef.current) return;
      setStatus('ready');
      onResolved(result);
      dialog.onClose();
    } catch (err) {
      if (epoch !== epochRef.current) return;
      setStatus('error');
      setMessage(mediaUploadErrorMessage(err));
    }
  }

  const busy = status === 'uploading';

  return (
    <Modal {...dialog} withCloseButton title={copy.title}>
      <Stack gap="md">
        <Alert color="blue" variant="light" icon={<IconBolt size={16} />}>
          <Text size="sm">
            This file is a <strong>private generation input</strong> — it isn&apos;t published, and
            the app receives a link to it. Upload {copy.types}, up to {kind === 'image' ? 24 : 64}{' '}
            MB.
          </Text>
        </Alert>

        <Group gap={8}>
          <StatusBadge status={status} />
        </Group>

        <FileInput
          label={copy.label}
          placeholder="Select a file"
          accept={accept}
          clearable
          disabled={busy}
          leftSection={<IconUpload size={16} />}
          value={null}
          onChange={(f: File | null) => void handleFile(f)}
          data-testid="block-media-upload-file-input"
        />

        {unreadablePick && (
          <UnreadablePickAlert
            accept={accept.split(',')}
            disabled={busy}
            onFiles={([file]) => void handleFile(file)}
          />
        )}

        {message && (
          <Text
            size="xs"
            c={status === 'error' ? 'red' : 'dimmed'}
            data-testid="block-media-upload-message"
          >
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
          no file selected
        </Text>
      );
  }
}
