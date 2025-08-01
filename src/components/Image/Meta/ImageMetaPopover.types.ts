import type { MediaType } from '~/shared/utils/prisma/enums';

export interface ImageMetaPopoverProps {
  imageId: number;
  children: React.ReactElement;
  type: MediaType;
  // TODO - accept meta props
}
