import { MantineNumberSize } from '@mantine/core';
import { useContainerQuery } from '~/components/ContainerProvider/useContainerQuery';

export const useContainerLargerThan = (width: MantineNumberSize, containerName?: string) =>
  useContainerQuery({ type: 'min-width', width, containerName });
