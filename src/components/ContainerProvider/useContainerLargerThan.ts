import { MantineSpacing } from '@mantine/core';
import { useContainerQuery } from '~/components/ContainerProvider/useContainerQuery';

export const useContainerLargerThan = (width: MantineSpacing) =>
  useContainerQuery({ type: 'min-width', width });
