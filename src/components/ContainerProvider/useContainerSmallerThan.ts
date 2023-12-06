import { MantineNumberSize } from '@mantine/core';
import { useContainerQuery } from '~/components/ContainerProvider/useContainerQuery';

export const useContainerSmallerThan = (width: MantineNumberSize, containerName?: string) =>
  useContainerQuery({ type: 'max-width', width, containerName });
