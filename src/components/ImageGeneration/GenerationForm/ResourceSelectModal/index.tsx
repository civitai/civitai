import { Modal } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { ResourceSelectProvider } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { ResourceSelectModalContent } from './ResourceSelectModalContent';
import { ResourceTypeRail } from './ResourceTypeRail';

export default function ResourceSelectModal(props: ResourceSelectModalProps) {
  const dialog = useDialogContext();
  // The resource role brings its own rail; the checkpoint role's comes from the
  // caller, because only the form-graph form knows about ecosystems.
  const Rail = props.rail ?? (props.role === 'resource' ? ResourceTypeRail : undefined);

  function handleClose() {
    dialog.onClose();
    props.onClose?.();
  }

  return (
    <Modal
      {...dialog}
      onClose={handleClose}
      size={1500}
      withCloseButton={false}
      padding={0}
      styles={{
        content: { overflow: 'hidden', display: 'flex', flexDirection: 'column' },
        body: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
      }}
    >
      <ResourceSelectProvider {...props}>
        <ResourceSelectModalContent Rail={Rail} />
      </ResourceSelectProvider>
    </Modal>
  );
}
