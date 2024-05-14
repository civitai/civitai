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

  // useEffect(() => {
  //   const element = document.querySelector<HTMLElement>('#main');
  //   console.log({ opened, element });
  //   if (!element) return;
  //   element.style.visibility = opened ? 'hidden' : 'visible';

  //   return () => {
  //     element.style.visibility = 'visible';
  //   };
  // }, [opened]);

  return (
    <Modal
      {...props}
      target="#main"
      zIndex={10000}
      styles={{
        root: { position: 'absolute' },
        body: { height: '100%', width: '100%', display: 'flex', flexDirection: 'column' },
      }}
    />
  );
}
