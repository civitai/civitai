import { MantineColor } from '@mantine/core';
import { GenerationRequestStatus } from '~/server/common/enums';

export const generationStatusColors: Record<GenerationRequestStatus, MantineColor> = {
  [GenerationRequestStatus.Pending]: 'gray',
  [GenerationRequestStatus.Cancelled]: 'gray',
  [GenerationRequestStatus.Processing]: 'yellow',
  [GenerationRequestStatus.Succeeded]: 'green',
  [GenerationRequestStatus.Error]: 'red',
};
