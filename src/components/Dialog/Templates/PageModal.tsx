import { ModalProps, Modal } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { useDialogStore, useStackingContext } from '~/components/Dialog/dialogStore';

export function PageModal(props: ModalProps) {
  const { opened } = props;
  const stackingContextRef = useRef(useDialogStore.getState().dialogs.length);
  useEffect(() => {
    const stackingContext = stackingContextRef.current;
    const timeout = setTimeout(() => {
      useStackingContext.setState((state) => ({
        stackingContext: [...state.stackingContext, stackingContext],
      }));
    }, 1000);

    return () => {
      if (timeout) clearTimeout(timeout);
      useStackingContext.setState((state) => ({
        stackingContext: [...state.stackingContext.filter((x) => x !== stackingContext)],
      }));
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
