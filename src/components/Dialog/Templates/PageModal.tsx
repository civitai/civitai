import { ModalProps, Modal } from '@mantine/core';

export function PageModal(props: ModalProps) {
  return (
    <Modal
      {...props}
      target="main"
      styles={{
        root: { position: 'absolute' },
        body: { height: '100%', width: '100%', display: 'flex', flexDirection: 'column' },
      }}
    />
  );
}
