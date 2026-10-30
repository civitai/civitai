import { Button, Group, Modal, Select, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  reasonFormLabels,
  reasonFormValues,
  textActionReady,
} from '~/components/CreatorShop/Services/deals/deal-ui';

export type DealTextActionChoice = { label: string; color?: string; value: string };

/**
 * A reason picker and/or a reason box, with one or more submit buttons; resolves with the
 * button's value, the text and the code. A muted viewer gets no box: the server drops their text,
 * so the form never asks for what it will throw away.
 */
export function DealTextActionModal({
  title,
  description,
  placeholder,
  required = false,
  label,
  maxLength,
  choices,
  codes,
  muted = false,
  onSubmit,
}: {
  title: string;
  description?: string;
  placeholder?: string;
  /** A reason is needed: the text, or a code when there is a picker. */
  required?: boolean;
  /** Defaults to "Reason" when required, "Comment (optional)" otherwise. */
  label?: string;
  maxLength: number;
  choices: DealTextActionChoice[];
  codes?: { value: string; label: string }[];
  muted?: boolean;
  onSubmit: (value: string, text: string | undefined, code: string | undefined) => Promise<unknown>;
}) {
  const dialog = useDialogContext();
  const [text, setText] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const hasCodes = !!codes?.length;
  const values = reasonFormValues({ muted, text, code });
  const ready = textActionReady({ required, text: values.text ?? '', code, hasCodes });
  const labels = reasonFormLabels({ required, hasCodes, muted });

  const submit = async (value: string) => {
    setPending(value);
    try {
      await onSubmit(value, values.text, values.code);
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
        {!!codes?.length && (
          <Select
            label="Reason"
            placeholder="Pick a reason"
            data={codes}
            value={code}
            onChange={setCode}
            description={labels.hint}
            clearable={labels.codeClearable}
            withAsterisk={labels.codeRequired}
          />
        )}
        {muted ? (
          <Text size="xs" c="dimmed">
            Your account can&apos;t add comments right now
            {codes?.length ? ', so pick the closest reason.' : '.'}
          </Text>
        ) : (
          <Textarea
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder={placeholder}
            autosize
            minRows={3}
            maxLength={maxLength}
            withAsterisk={labels.textRequired}
            label={label ?? labels.textLabel}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Back
          </Button>
          {choices.map((choice) => (
            <Button
              key={choice.value}
              color={choice.color}
              disabled={!ready || (pending !== null && pending !== choice.value)}
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
