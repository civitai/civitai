import { MantineSpacing } from '@mantine/core';
import { useContainerQuery } from '~/components/ContainerProvider/useContainerQuery';

export const useContainerSmallerThan = (width: MantineSpacing) =>
  useContainerQuery({ type: 'max-width', width });
