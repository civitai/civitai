import type { InputWrapperProps } from '@mantine/core';
import { Group, Input, LoadingOverlay, Paper, Stack, Text } from '@mantine/core';
import type { FileWithPath } from '@mantine/dropzone';
import { Dropzone } from '@mantine/dropzone';
import { useDidUpdate } from '@mantine/hooks';
import { useEffect, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants } from '~/server/common/constants';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { formatBytes } from '~/utils/number-helpers';
import { IconUser } from '@tabler/icons-react';
import { isValidURL } from '~/utils/type-guards';
import { isUploadInFlight } from '~/utils/upload-status';
import { isAndroidDevice } from '~/utils/device-helpers';

type SimpleImageUploadProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: string | { url: string };
  onChange?: (value: CustomFile) => void;
  previewWidth?: number;
  maxSize?: number;
  previewDisabled?: boolean;
};

/**
 * The preview the CURRENT form value implies, or `undefined` when the form holds nothing.
 *
 * Used both for the initial state and to put the preview back after a refused upload —
 * `handleDrop` clears it optimistically, and on failure the form value is unchanged, so
 * the honest render is the one that value describes.
 */
function valuePreview(value: SimpleImageUploadProps['value']) {
  if (typeof value === 'string') return isValidURL(value) ? { url: value } : undefined;
  return value ? { url: value.url } : undefined;
}

export function ProfileImageUpload({
  value,
  onChange,
  previewWidth = 96,
  maxSize = constants.mediaUpload.maxImageFileSize,
  previewDisabled,
  ...props
}: SimpleImageUploadProps) {
  const { uploadToCF, files: imageFiles, resetFiles } = useCFImageUpload();
  const [image, setImage] = useState<{ url: string; objectUrl?: string } | undefined>(() =>
    valuePreview(value)
  );
  const [error, setError] = useState('');

  const imageFile = imageFiles[0];

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    const hasLargeFile = droppedFiles.some((file) => file.size > maxSize);
    if (hasLargeFile) return setError(`File should not exceed ${formatBytes(maxSize)}`);

    setError('');
    setImage(undefined);
    resetFiles();
    const [file] = droppedFiles;

    // 🔴 A refused PUT now REJECTS (see `useCFImageUpload`). Without this catch the
    // rejection escapes into Mantine's `onDrop`, which discards the promise: the user is
    // told nothing at all and the console gets an unhandled rejection. This wrapper has
    // its own `error` slot, so the message goes there rather than into a notification.
    try {
      await uploadToCF(file);
    } catch (e) {
      setError((e as Error).message);
      // 🔴 The form value never changed, so put its preview back. `handleDrop` cleared it
      // optimistically above; leaving it cleared renders an empty circle for a user whose
      // avatar is still set, which reads as "your avatar was removed".
      setImage(valuePreview(value));
    }
  };

  useDidUpdate(() => {
    if (!imageFile) return;
    /**
     * 🔴 ONLY A SUCCEEDED UPLOAD MAY SET THE PREVIEW.
     *
     * This used to `setImage(...)` unconditionally and then call `onChange` only on
     * `success`. While the latched `progress < 100` spinner existed the preview branch was
     * unreachable on failure, so the bug was invisible; deriving the spinner from `status`
     * exposed it. On a refused PUT the effect fired with `status: 'error'` and painted the
     * NEW avatar into the circle beside the error line, while `onChange` never fired and
     * the form still held the OLD value — so Save silently kept the old avatar.
     *
     * The preview and the emitted value must come from the same branch, because they are
     * the same claim: "this is the image the form now holds."
     */
    if (imageFile.status !== 'success') return;

    setImage({ url: imageFile.url, objectUrl: imageFile.objectUrl });
    const { status, ...file } = imageFile;
    onChange?.(file);
  }, [imageFile]);

  useEffect(() => {
    const currentValue = value ? (typeof value === 'string' ? { url: value } : value) : undefined;
    if (currentValue && image?.url !== currentValue.url) {
      setImage(currentValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const hasError = !!props.error || !!error;
  // 🔴 Derived from `status`, NOT from `progress` — see `isUploadInFlight`. A PUT refused
  // before its first progress event leaves `progress` at 0, which `progress < 100` reads
  // as "still uploading" forever.
  const showLoading = isUploadInFlight(imageFile);

  return (
    <Input.Wrapper {...props} error={props.error ?? error}>
      <Group style={{ alignItems: 'stretch', marginBottom: hasError ? 5 : undefined }} grow>
        <Paper
          withBorder={!image}
          style={{
            position: 'relative',
            height: `${previewWidth}px`,
            width: `${previewWidth}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            flexGrow: 0,
            borderRadius: '50%',
          }}
        >
          {showLoading ? (
            <LoadingOverlay visible={!!showLoading} />
          ) : !image ? (
            <IconUser size={40} />
          ) : (
            <div style={{ width: '100%', height: '100%' }}>
              <EdgeMedia
                src={image.objectUrl ?? image.url}
                style={{ minHeight: '100%', objectFit: 'cover' }}
              />
            </div>
          )}
        </Paper>

        <Stack maw="unset">
          <Dropzone
            onDrop={handleDrop}
            accept={IMAGE_MIME_TYPE}
            maxFiles={1}
            style={{
              flex: 1,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
            }}
            radius="md"
            styles={(theme) => ({
              root: hasError ? { borderColor: theme.colors.red[6] } : undefined,
            })}
            useFsAccessApi={!isAndroidDevice()}
          >
            <Text c="dimmed">{`Drop image here, should not exceed ${formatBytes(maxSize)}`}</Text>
          </Dropzone>
        </Stack>
      </Group>
    </Input.Wrapper>
  );
}
