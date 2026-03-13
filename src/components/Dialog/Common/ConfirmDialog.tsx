import type { ButtonProps, MantineSize } from '@mantine/core';
import { Button, Group, Modal, Stack, Text, useMantineTheme } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export default function ConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
  labels,
  confirmProps,
  cancelProps,
  size,
  zIndex,
  autoFocusConfirm,
}: {
  title?: React.ReactNode;
  message: React.ReactNode;
  onConfirm?: () => Promise<unknown> | unknown;
  onCancel?: () => void;
  labels?: { cancel?: string; confirm?: string };
  confirmProps?: ButtonProps;
  cancelProps?: ButtonProps;
  size?: number | MantineSize;
  zIndex?: number;
  autoFocusConfirm?: boolean;
}) {
  const dialog = useDialogContext();
  const theme = useMantineTheme();
  const [loading, setLoading] = useState(false);
  // Show a focus ring on the confirm button when auto-focused. We use :focus (not
  // :focus-visible) via inline style so it works for programmatic focus too.
  const [confirmFocused, setConfirmFocused] = useState(false);
  useEffect(() => {
    if (autoFocusConfirm && dialog.opened) setConfirmFocused(true);
  }, [autoFocusConfirm, dialog.opened]);

  const handleCancel = () => {
    onCancel?.();
    dialog.onClose();
  };

  const handleConfirm = async () => {
    const result = onConfirm?.();
    if (result instanceof Promise) {
      setLoading(true);
      await Promise.resolve(result);
      setLoading(false);
    }
    // await onConfirm?.();
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      title={<Text className="font-semibold">{title}</Text>}
      onClose={handleCancel}
      centered
      size={size}
      zIndex={zIndex ?? dialog.zIndex}
    >
      <Stack>
        {message}
        <Group
          justify="flex-end"
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.stopPropagation();
              const buttons =
                e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)');
              const idx = Array.from(buttons).indexOf(document.activeElement as HTMLElement);
              if (idx !== -1) {
                const next =
                  e.key === 'ArrowRight'
                    ? (idx + 1) % buttons.length
                    : (idx - 1 + buttons.length) % buttons.length;
                (buttons[next] as HTMLElement & { focus(o?: FocusOptions): void }).focus({
                  focusVisible: true,
                } as FocusOptions);
              }
            }
          }}
        >
          <Button variant="default" onClick={handleCancel} {...cancelProps}>
            {labels?.cancel ?? 'No'}
          </Button>
          <Button
            onClick={handleConfirm}
            loading={loading}
            {...confirmProps}
            data-autofocus={autoFocusConfirm ? 'true' : undefined}
            style={
              confirmFocused
                ? {
                    outline: `2px solid var(--mantine-color-${theme.primaryColor}-outline)`,
                    outlineOffset: '2px',
                    ...confirmProps?.style,
                  }
                : confirmProps?.style
            }
            onBlur={() => setConfirmFocused(false)}
          >
            {labels?.confirm ?? 'Yes'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
