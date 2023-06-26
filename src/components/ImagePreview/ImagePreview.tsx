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
  Menu,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageModel } from '~/server/selectors/image.selector';
// import { useImageLightbox } from '~/hooks/useImageLightbox';
import { EdgeImage, EdgeImageProps } from '~/components/EdgeImage/EdgeImage';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { IconAlertTriangle, IconCheck, IconInfoCircle, IconX } from '@tabler/icons-react';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { getClampedSize } from '~/utils/blurhash';
import { CSSProperties, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

type ImagePreviewProps = {
  nsfw?: boolean;
  aspectRatio?: number;
  // lightboxImages?: ImageModel[];
  image: Omit<ImageModel, 'tags' | 'scannedAt' | 'userId' | 'postId'>;
  edgeImageProps?: Omit<EdgeImageProps, 'src'>;
  withMeta?: boolean;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  radius?: MantineNumberSize;
  cropFocus?: 'top' | 'bottom' | 'left' | 'right' | 'center';
} & Omit<BoxProps, 'component'>;

export function ImagePreview({
  image: {
    id,
    url,
    name,
    width,
    height,
    hash,
    meta,
    generationProcess,
    needsReview: initialNeedsReview,
  },
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
  // const user = useCurrentUser();
  // const [needsReview, setNeedsReview] = useState(initialNeedsReview);

  // TODO Briant: Perhaps move this to a moderation provider or store?
  // const moderateImagesMutation = trpc.image.moderate.useMutation();
  // const handleModerate = async (accept: boolean) => {
  //   if (!user?.isModerator) return;
  //   moderateImagesMutation.mutate({
  //     ids: [id],
  //     needsReview: accept ? null : undefined,
  //     delete: !accept ? true : undefined,
  //     reviewType: 'minor',
  //   });
  //   setNeedsReview(null);
  // };

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
      imageId={id}
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

  // let NeedsReviewBadge = needsReview && (
  //   <ThemeIcon size="lg" color="yellow">
  //     <IconAlertTriangle strokeWidth={2.5} size={26} />
  //   </ThemeIcon>
  // );

  // if (needsReview && user?.isModerator)
  //   NeedsReviewBadge = (
  //     <Menu position="bottom">
  //       <Menu.Target>
  //         <Box>{NeedsReviewBadge}</Box>
  //       </Menu.Target>
  //       <Menu.Dropdown>
  //         <Menu.Item
  //           onClick={() => handleModerate(true)}
  //           icon={<IconCheck size={14} stroke={1.5} />}
  //         >
  //           Approve
  //         </Menu.Item>
  //         <Menu.Item onClick={() => handleModerate(false)} icon={<IconX size={14} stroke={1.5} />}>
  //           Reject
  //         </Menu.Item>
  //       </Menu.Dropdown>
  //     </Menu>
  //   );
  // else if (needsReview) {
  //   NeedsReviewBadge = (
  //     <HoverCard width={200} withArrow>
  //       <HoverCard.Target>{NeedsReviewBadge}</HoverCard.Target>
  //       <HoverCard.Dropdown p={8}>
  //         <Stack spacing={0}>
  //           <Text weight="bold" size="xs">
  //             Flagged for review
  //           </Text>
  //           <Text size="xs">
  //             {`This image won't be visible to other users until it's reviewed by our moderators.`}
  //           </Text>
  //         </Stack>
  //       </HoverCard.Dropdown>
  //     </HoverCard>
  //   );
  // }

  const edgeImageStyle: CSSProperties = {
    maxHeight: '100%',
    maxWidth: '100%',
  };
  // if (onClick) edgeImageStyle.cursor = 'pointer'; // !important - this line was causing hydration errors
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
        {/* {NeedsReviewBadge} */}
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
