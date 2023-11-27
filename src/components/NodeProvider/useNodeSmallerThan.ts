import { MantineNumberSize } from '@mantine/core';
import { useContainerQuery } from '~/components/NodeProvider/useContainerQuery';

export const useNodeSmallerThan = (width: MantineNumberSize) =>
  useContainerQuery({ type: 'max-width', width });
