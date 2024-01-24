import { ModalProps, Modal } from '@mantine/core';
import { useEffect } from 'react';
import { useStackingContext } from '~/components/Dialog/dialogStore';

export function PageModal(props: ModalProps) {
  const { opened } = props;
  const { increase, decrease } = useStackingContext();
  useEffect(() => {
    increase();

    return () => {
      decrease();
    };
  }, [opened]);

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
