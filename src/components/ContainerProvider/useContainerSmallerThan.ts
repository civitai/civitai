import type { MantineNumberSize } from '@mantine/core';
import { useContainerQuery } from '~/components/ContainerProvider/useContainerQuery';

export const useContainerSmallerThan = (width: MantineNumberSize) =>
  useContainerQuery({ type: 'max-width', width });
