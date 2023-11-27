import { MantineNumberSize } from '@mantine/core';
import { useContainerQuery } from '~/components/ContainerProvider/useContainerQuery';

export const useContainerLargerThan = (width: MantineNumberSize) =>
  useContainerQuery({ type: 'min-width', width });
