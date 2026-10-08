import { Alert, Button, Text } from '@mantine/core';
import { useRef, useState } from 'react';
import { isAndroidDevice } from '~/utils/device-helpers';
import { formatBytes } from '~/utils/number-helpers';
import { unreadablePickMessage } from '~/utils/unreadable-pick';

/**
 * Shown when `count` picked files could not be read. On Android the button opens a file input with
 * no `accept`: an image-only `accept` is what sends Android to the photo picker, and without one it
 * offers Files. Elsewhere there is no such second chooser, so only the message is shown.
 *
 * Nothing filters the Files chooser, so the picked files' types and sizes are checked here. A
 * selection with any file that fails either check is refused whole: `onFiles` is not called and the
 * alert stays, with the reason, so the user can choose again.
 */
export function UnreadablePickAlert({
  accept,
  count = 1,
  maxSize,
  multiple = false,
  disabled = false,
  onFiles,
}: {
  accept: readonly string[];
  count?: number;
  maxSize?: number;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rejection, setRejection] = useState<'type' | 'size' | null>(null);
  const android = isAndroidDevice();

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    const reason = files.some((file) => !accept.includes(file.type))
      ? 'type'
      : maxSize !== undefined && files.some((file) => file.size > maxSize)
      ? 'size'
      : null;
    setRejection(reason);
    if (!reason) onFiles(files);
  }

  return (
    <Alert color="yellow">
      <div className="flex flex-col gap-2">
        <Text size="sm">{unreadablePickMessage(count, android)}</Text>
        {rejection === 'type' && (
          <Text size="sm" c="red">
            That file type isn&apos;t supported here.
          </Text>
        )}
        {rejection === 'size' && maxSize !== undefined && (
          <Text size="sm" c="red">
            Files should not exceed {formatBytes(maxSize)}.
          </Text>
        )}
        {android && (
          <>
            <div>
              <Button
                size="compact-sm"
                disabled={disabled}
                onClick={() => inputRef.current?.click()}
              >
                Choose from Files
              </Button>
            </div>
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              multiple={multiple}
              onChange={handleChange}
              data-testid="unreadable-pick-files-input"
            />
          </>
        )}
      </div>
    </Alert>
  );
}
