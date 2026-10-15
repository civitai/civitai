import { Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export type DealTextActionChoice = { label: string; color?: string; value: string };

/** One reason box with one or more submit buttons; resolves with the button's value and the text. */
export function DealTextActionModal({
  title,
  description,
  placeholder,
  required = false,
  maxLength,
  choices,
  onSubmit,
}: {
  title: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  maxLength: number;
  choices: DealTextActionChoice[];
  onSubmit: (value: string, text: string | undefined) => Promise<unknown>;
}) {
  const dialog = useDialogContext();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const trimmed = text.trim();

  const submit = async (value: string) => {
    setPending(value);
    try {
      await onSubmit(value, trimmed || undefined);
      dialog.onClose();
    } catch {
      // The mutation's own onError has already told the viewer.
    } finally {
      setPending(null);
    }
  };

  return (
    <Modal {...dialog} title={title}>
      <Stack gap="md">
        {description && (
          <Text size="sm" c="dimmed">
            {description}
          </Text>
        )}
        <Textarea
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          placeholder={placeholder}
          autosize
          minRows={3}
          maxLength={maxLength}
          withAsterisk={required}
          label={required ? 'Reason' : 'Comment (optional)'}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Back
          </Button>
          {choices.map((choice) => (
            <Button
              key={choice.value}
              color={choice.color}
              disabled={(required && !trimmed) || (pending !== null && pending !== choice.value)}
              loading={pending === choice.value}
              onClick={() => submit(choice.value)}
            >
              {choice.label}
            </Button>
          ))}
        </Group>
      </Stack>
    </Modal>
  );
}
