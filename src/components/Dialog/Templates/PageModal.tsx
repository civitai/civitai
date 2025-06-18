import type { ModalProps } from '@mantine/core';
import { Modal } from '@mantine/core';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';

export function PageModal({ children, ...props }: ModalProps) {
  return (
    <Modal
      transitionProps={{
        duration: 0,
      }}
      {...props}
      styles={{
        root: { position: 'absolute' },
        body: { height: '100%', width: '100%', display: 'flex', flexDirection: 'column' },
      }}
    >
      <ScrollArea pb={0}>{children}</ScrollArea>
    </Modal>
  );
}
