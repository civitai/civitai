import {
  ActionIcon,
  AspectRatio,
  Box,
  BoxProps,
  createStyles,
  Group,
  MantineNumberSize,
} from '@mantine/core';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { IconInfoCircle } from '@tabler/icons-react';
import { CSSProperties } from 'react';
import { EdgeMedia, EdgeMediaProps } from '~/components/EdgeMedia/EdgeMedia';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { ImageGetInfinite } from '~/types/router';

type ImagePreviewProps = {
  nsfw?: boolean;
  aspectRatio?: number;
  // lightboxImages?: ImageModel[];
  image: Pick<
    ImageGetInfinite[number],
    'id' | 'url' | 'name' | 'width' | 'height' | 'hash' | 'meta' | 'generationProcess' | 'type'
  >;
  edgeImageProps?: Omit<EdgeMediaProps, 'src'>;
  withMeta?: boolean;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  radius?: MantineNumberSize;
  cropFocus?: 'top' | 'bottom' | 'left' | 'right' | 'center';
} & Omit<BoxProps, 'component'>;

export function ImagePreview({
  image: { id, url, name, type, width, height, hash, meta, generationProcess },
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
  edgeImageProps.width ??= width ?? undefined;

  if (!edgeImageProps.width && !edgeImageProps.height) {
    if (!edgeImageProps.height && width) edgeImageProps.width = width;
    else if (!edgeImageProps.width && height) edgeImageProps.height = height;
  }

  if (!width || !height) return null;

  const Meta = !nsfw && withMeta && meta && (
    <ImageMetaPopover meta={meta} generationProcess={generationProcess ?? 'txt2img'} imageId={id}>
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
    ...edgeImageProps.style,
    maxHeight: '100%',
    maxWidth: '100%',
  };
  // if (onClick) edgeImageStyle.cursor = 'pointer'; // !important - this line was causing hydration errors
  if (style?.height || style?.maxHeight) edgeImageStyle.maxHeight = '100%';
  const Image = nsfw ? (
    <div className="relative size-full">
      <MediaHash hash={hash} width={width} height={height} />
    </div>
  ) : (
    <EdgeMedia
      src={url}
      name={name ?? id.toString()}
      alt={name ?? undefined}
      type={type}
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
