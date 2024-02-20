import { createContextModal } from '~/components/Modals/utils/createContextModal';

import { Text } from '@mantine/core';
import { RunPartners } from '~/components/RunStrategy/RunPartners';

const { openModal: openRunStrategyModal, Modal } = createContextModal<{ modelVersionId: number }>({
  name: 'runStrategy',
  title: <Text weight={700}>Generate images using this model now</Text>,
  size: 600,
  Element: ({ props: { modelVersionId } }) => <RunPartners modelVersionId={modelVersionId} />,
});

export { openRunStrategyModal };
export default Modal;
