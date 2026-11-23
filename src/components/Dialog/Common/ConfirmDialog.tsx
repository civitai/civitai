import type { ButtonProps, GroupProps, MantineSize } from '@mantine/core';
import { Button, Group, Modal, Stack, Text, useMantineTheme } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { Dialog } from '~/components/Dialog/dialogStore';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { atLeastOverMobileSheet } from '~/shared/constants/app-layout.constants';

type DialogButtonProps = ButtonProps & {
  [attribute: `data-${string}`]: string | boolean | undefined;
};

type ConfirmDialogProps = {
  title?: React.ReactNode;
  message: React.ReactNode;
  /** A returned promise shows a spinner; the dialog closes when it resolves and stays open if it rejects. */
  onConfirm?: () => Promise<unknown> | unknown;
  onCancel?: () => void;
  labels?: { cancel?: string; confirm?: string };
  confirmProps?: DialogButtonProps;
  cancelProps?: DialogButtonProps;
  /** Props for the row that holds the buttons, e.g. `{ justify: 'center' }`. */
  groupProps?: GroupProps;
  size?: number | MantineSize;
  zIndex?: number;
  autoFocusConfirm?: boolean;
  /** False leaves the dialog open after confirming; close it with `dialogStore.closeById(id)`. */
  closeOnConfirm?: boolean;
};

type OpenConfirmProps = ConfirmDialogProps & {
  id?: Dialog['id'];
  /** Runs once when the confirm closes itself, by any route: confirm, cancel, X, Escape, outside click, Back. Not on `dialogStore.closeById`. */
  onClose?: () => void;
};

/** Opens a confirm on the dialog stack. Labels default to Confirm / Cancel. */
export function openConfirm({ id, onClose, ...props }: OpenConfirmProps) {
  dialogStore.trigger({
    component: ConfirmDialog,
    id,
    props: { ...props, labels: { confirm: 'Confirm', cancel: 'Cancel', ...props.labels } },
    options: { onClose },
  });
}

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
  closeOnConfirm = true,
  groupProps,
}: ConfirmDialogProps) {
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
      try {
        await result; // a rejection skips the close below, so the user can retry
      } finally {
        setLoading(false);
      }
    }
    if (closeOnConfirm) dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      title={<Text className="font-semibold">{title}</Text>}
      onClose={handleCancel}
      centered
      size={size}
      zIndex={zIndex ?? atLeastOverMobileSheet(dialog.zIndex)}
    >
      <Stack>
        {message}
        <Group
          justify="flex-end"
          {...groupProps}
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
            {...confirmProps}
            // After the spread: a caller's `loading` is fixed when the dialog opens, and must not switch
            // off the spinner (and its click guard) while an async onConfirm runs.
            loading={loading || !!confirmProps?.loading}
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
