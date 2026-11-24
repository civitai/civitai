import type { ModalProps } from '@mantine/core';
import { Modal } from '@mantine/core';
import type { Dialog } from '~/components/Dialog/dialogStore';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { atLeastOverMobileSheet } from '~/shared/constants/app-layout.constants';

type ContentDialogProps = Pick<
  ModalProps,
  | 'title'
  | 'size'
  | 'centered'
  | 'withCloseButton'
  | 'closeOnClickOutside'
  | 'closeOnEscape'
  | 'radius'
  | 'zIndex'
> & {
  /** A function child gets `close`, for buttons written inline at the call site. */
  children: React.ReactNode | ((args: { close: () => void }) => React.ReactNode);
};

/** A titled modal around arbitrary content, on the dialog stack. Components inside can also close it with `useDialogContext().onClose`. */
export function openContentDialog({ id, ...props }: ContentDialogProps & { id?: Dialog['id'] }) {
  dialogStore.trigger({ component: ContentDialog, id, props });
}

export default function ContentDialog({
  children,
  zIndex,
  closeOnEscape = true,
  ...modalProps
}: ContentDialogProps) {
  const dialog = useDialogContext();
  return (
    <Modal
      {...dialog}
      {...modalProps}
      closeOnEscape={dialog.closeOnEscape && closeOnEscape}
      zIndex={zIndex ?? atLeastOverMobileSheet(dialog.zIndex)}
    >
      {typeof children === 'function' ? children({ close: dialog.onClose }) : children}
    </Modal>
  );
}
