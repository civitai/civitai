import { Modal } from '@mantine/core';
import { InstantSearch } from 'react-instantsearch';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import {
  ResourceSelectProvider,
  useResourceSelectContext,
} from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { searchIndexMap } from '~/components/Search/search.types';
import { searchClient } from './searchClient';
import { ResourceSelectModalContent } from './ResourceSelectModalContent';

export default function ResourceSelectModal(props: ResourceSelectModalProps) {
  return (
    <ResourceSelectProvider {...props}>
      <ResourceSelectModalWrapper />
    </ResourceSelectProvider>
  );
}

function ResourceSelectModalWrapper() {
  const dialog = useDialogContext();
  const { onClose } = useResourceSelectContext();

  function handleClose() {
    dialog.onClose();
    onClose?.();
  }

  return (
    <Modal
      {...dialog}
      onClose={handleClose}
      size={1200}
      withCloseButton={false}
      padding={0}
      styles={{
        content: { overflow: 'hidden', display: 'flex', flexDirection: 'column' },
        body: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
      }}
    >
      <ScrollArea id="resource-select-modal">
        <InstantSearch
          searchClient={searchClient}
          indexName={searchIndexMap.models}
          future={{ preserveSharedStateOnUnmount: true }}
        >
          <ResourceSelectModalContent />
        </InstantSearch>
      </ScrollArea>
    </Modal>
  );
}
