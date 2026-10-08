import { Alert, Button, Text } from '@mantine/core';
import { useRef, useState } from 'react';
import { UNREADABLE_PICK_MESSAGE } from '~/utils/unreadable-pick';

/**
 * Shown when a picked file could not be read. The button opens a file input with no `accept`: an
 * image-only `accept` is what sends Android to the photo picker, and without one it offers Files.
 * Nothing filters that chooser, so the picked files' types are checked here.
 */
export function UnreadablePickAlert({
  accept,
  multiple = false,
  disabled = false,
  onFiles,
}: {
  accept: readonly string[];
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [typeError, setTypeError] = useState(false);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    const accepted = files.filter((file) => accept.includes(file.type));
    setTypeError(accepted.length < files.length);
    if (accepted.length) onFiles(accepted);
  }

  return (
    <Alert color="yellow">
      <div className="flex flex-col gap-2">
        <Text size="sm">{UNREADABLE_PICK_MESSAGE}</Text>
        {typeError && (
          <Text size="sm" c="red">
            That file type isn&apos;t supported here.
          </Text>
        )}
        <div>
          <Button size="compact-sm" disabled={disabled} onClick={() => inputRef.current?.click()}>
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
      </div>
    </Alert>
  );
}
