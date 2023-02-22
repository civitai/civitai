import {
  ActionIcon,
  AspectRatio,
  Box,
  BoxProps,
  Center,
  createStyles,
  Group,
  HoverCard,
  MantineNumberSize,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageModel } from '~/server/selectors/image.selector';
// import { useImageLightbox } from '~/hooks/useImageLightbox';
import { EdgeImage, EdgeImageProps } from '~/components/EdgeImage/EdgeImage';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { IconAlertTriangle, IconExclamationMark, IconInfoCircle } from '@tabler/icons';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { getClampedSize } from '~/utils/blurhash';
import { CSSProperties } from 'react';

type ImagePreviewProps = {
  nsfw?: boolean;
  aspectRatio?: number;
  // lightboxImages?: ImageModel[];
  image: Omit<ImageModel, 'tags'>;
  edgeImageProps?: Omit<EdgeImageProps, 'src'>;
  withMeta?: boolean;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  radius?: MantineNumberSize;
  cropFocus?: 'top' | 'bottom' | 'left' | 'right' | 'center';
} & Omit<BoxProps, 'component'>;

export function ImagePreview({
  image: { id, url, name, width, height, hash, meta, generationProcess, needsReview },
  edgeImageProps = {},
  nsfw,
  aspectRatio,
  withMeta,
  style,
  onClick,
  className,
  radius = 0,
  cropFocus,
  ...props
}: ImagePreviewProps) {
  const { classes, cx } = useStyles({ radius });
  aspectRatio ??= Math.max((width ?? 16) / (height ?? 9), 9 / 16);

  if (!edgeImageProps.width && !edgeImageProps.height) {
    if (!edgeImageProps.height && width) edgeImageProps.width = width;
    else if (!edgeImageProps.width && height) edgeImageProps.height = height;
  }

  if (!width || !height) return null;
  const { width: cw, height: ch } = getClampedSize(
    width,
    height,
    edgeImageProps.height ?? edgeImageProps.width ?? 500,
    edgeImageProps.height ? 'height' : edgeImageProps.width ? 'width' : 'all'
  );

  const Meta = !nsfw && withMeta && meta && (
    <ImageMetaPopover
      meta={meta as ImageMetaProps}
      generationProcess={generationProcess ?? 'txt2img'}
    >
      <ActionIcon variant="transparent" size="lg">
        <IconInfoCircle
          color="white"
          filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
          opacity={0.8}
          strokeWidth={2.5}
          size={26}
        />
      </ActionIcon>
    </ImageMetaPopover>
  );

  const NeedsReviewBadge = needsReview && (
    <HoverCard width={200} withArrow>
      <HoverCard.Target>
        <ThemeIcon size="lg" color="yellow">
          <IconAlertTriangle strokeWidth={2.5} size={26} />
        </ThemeIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown p={8}>
        <Stack spacing={0}>
          <Text weight="bold" size="xs">
            Flagged by age detection
          </Text>
          <Text size="xs">
            {`This image won't be visible to other users until it's reviewed by our moderators.`}
          </Text>
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );

  const edgeImageStyle: CSSProperties = {
    maxHeight: '100%',
    maxWidth: '100%',
  };
  if (onClick) edgeImageStyle.cursor = 'pointer';
  if (style?.height || style?.maxHeight) edgeImageStyle.maxHeight = '100%';
  const Image = nsfw ? (
    <Center style={{ width: cw, height: ch, maxWidth: '100%' }}>
      <MediaHash hash={hash} width={width} height={height} />
    </Center>
  ) : (
    <EdgeImage
      src={url}
      name={name ?? id.toString()}
      alt={name ?? undefined}
      {...edgeImageProps}
      onClick={onClick}
      style={edgeImageStyle}
    />
  );

  return (
    <Box className={cx(classes.root, className)} style={{ ...style }} {...props}>
      {aspectRatio === 0 ? (
        Image
      ) : (
        <AspectRatio
          ratio={aspectRatio}
          sx={{
            color: 'white',
            ['& > img, & > video']: {
              objectPosition: cropFocus ?? 'center',
            },
          }}
        >
          {Image}
        </AspectRatio>
      )}
      <Group spacing={4} sx={{ position: 'absolute', bottom: '5px', right: '5px' }}>
        {NeedsReviewBadge}
        {Meta}
      </Group>
    </Box>
  );
}

const useStyles = createStyles((theme, { radius }: { radius?: MantineNumberSize }) => ({
  root: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: theme.fn.radius(radius),
  },
}));
