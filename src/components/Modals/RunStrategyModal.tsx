import { createContextModal } from '~/components/Modals/utils/createContextModal';

import { Text } from '@mantine/core';
import { RunPartners } from '~/components/RunStrategy/RunPartners';

const { openModal: openRunStrategyModal, Modal } = createContextModal<{ modelVersionId: number }>({
  name: 'runStrategy',
  title: <Text fw={700}>Generate using this model now</Text>,
  size: 600,
  Element: ({ props: { modelVersionId } }) => <RunPartners modelVersionId={modelVersionId} />,
});

export { openRunStrategyModal };
export default Modal;
