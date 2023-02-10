import { ContextModalProps, openContextModal } from '@mantine/modals';
import { ModalProps } from '@mantine/core';

type ContextProps<T extends Record<string, unknown>> = {
  context: {
    close: () => void;
  };
  props: T;
};

type CreateContextModalProps<T extends Record<string, unknown>> = {
  name: string;
  Element:
    | React.ForwardRefExoticComponent<ContextProps<T>>
    | ((props: ContextProps<T>) => JSX.Element);
} & Partial<Omit<ModalProps, 'opened'>>;

export function createContextModal<T extends Record<string, unknown>>({
  name,
  Element,
  ...modalProps
}: CreateContextModalProps<T>) {
  const openModal = (innerProps: T) => {
    if (!location.href.includes('#')) history.pushState(history.state, '', `${location.href}#`);
    openContextModal({
      modal: name,
      ...modalProps,
      onClose: () => {
        if (location.href.includes('#')) history.back();
        modalProps.onClose?.();
      },
      innerProps,
    });
  };

  function Modal({ context, id, innerProps }: ContextModalProps<T>) {
    const onClose = () => context.closeModal(id);
    return <Element context={{ close: onClose }} props={innerProps} />;
  }

  return { openModal, Modal };
}
