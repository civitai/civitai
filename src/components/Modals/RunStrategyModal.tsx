import { Text, Modal } from '@mantine/core';
import { RunPartners } from '~/components/RunStrategy/RunPartners';
import { useDialogContext } from '~/components/Dialog/DialogContext';

export default function RunStrategyModal({ modelVersionId }: { modelVersionId: number }) {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} size={600} title={<Text fw={700}>Generate using this model now</Text>}>
      <RunPartners modelVersionId={modelVersionId} />
    </Modal>
  );
}
