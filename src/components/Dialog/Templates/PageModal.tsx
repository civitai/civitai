import type { ModalProps } from '@mantine/core';
import { Modal } from '@mantine/core';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';

/** Above Mantine's modal default (200). Anything a page modal opens on top needs more. */
export const PAGE_MODAL_Z_INDEX = 250;

export function PageModal({ children, ...props }: ModalProps) {
  return (
    <Modal
      transitionProps={{ duration: 0 }}
      {...props}
      styles={{
        inner: { position: 'absolute' },
        body: { height: '100%', width: '100%', display: 'flex', flexDirection: 'column' },
      }}
      removeScrollProps={{ allowPinchZoom: true }}
      zIndex={PAGE_MODAL_Z_INDEX}
    >
      {/* a drag inside a modal should never reload the page underneath it */}
      <ScrollArea pb={0} withPullToRefresh={false}>
        {children}
      </ScrollArea>
    </Modal>
  );
}
