import type { MantineSpacing } from '@mantine/core';
import { useContainerQuery } from '~/components/ContainerProvider/useContainerQuery';

export const useContainerSmallerThan = (width: MantineSpacing, unmeasured?: boolean) =>
  useContainerQuery({ type: 'max-width', width, unmeasured });
