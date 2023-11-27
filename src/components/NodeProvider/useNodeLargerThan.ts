import { MantineNumberSize } from '@mantine/core';
import { useContainerQuery } from '~/components/NodeProvider/useContainerQuery';

export const useNodeLargerThan = (width: MantineNumberSize) =>
  useContainerQuery({ type: 'min-width', width });
