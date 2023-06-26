import { ContextModalProps } from '@mantine/modals';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { Generation } from '~/server/services/generation/generation.types';

export default function GeneratedImageLightbox({
  context,
  id,
  innerProps,
}: ContextModalProps<{
  image: Generation.Image;
  width: number;
}>) {
  const { image, width } = innerProps;
  return <EdgeImage src={image.url} width={width} />;
}
