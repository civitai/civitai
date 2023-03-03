import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { trpc } from '~/utils/trpc';
import { useEditPostContext, ImageUpload } from '~/components/Post/EditPostProvider';
import {
  createStyles,
  Stack,
  Menu,
  ActionIcon,
  Code,
  Group,
  Badge,
  AspectRatio,
} from '@mantine/core';
import { PostImage } from '~/server/selectors/post.selector';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { Fragment } from 'react';
import { IconDotsVertical } from '@tabler/icons';
import { DeleteImage } from '~/components/Image/DeleteImage/DeleteImage';
import { useCFUploadStore } from '~/store/cf-upload.store';

export default function EditPostImages() {
  const id = useEditPostContext((state) => state.id);
  const upload = useEditPostContext((state) => state.upload);
  const images = useEditPostContext((state) => state.images);

  const handleDrop = async (files: File[]) => upload(id, files);

  return (
    <Stack>
      <ImageDropzone onDrop={handleDrop} count={images.length} />
      <Stack>
        {images.map(({ type, data }, index) => (
          <Fragment key={index}>
            {type === 'image' ? <ImageController {...data} /> : <ImageUpload {...data} />}
          </Fragment>
        ))}
      </Stack>
    </Stack>
  );
}

function ImageController({
  id,
  url,
  previewUrl,
  name,
  nsfw,
  width,
  height,
  hash,
  meta,
  generationProcess,
  needsReview,
  _count,
}: PostImage) {
  const { classes, cx } = useStyles();
  const removeImage = useEditPostContext((state) => state.removeImage);
  return (
    <div className={classes.container}>
      <AspectRatio ratio={(width ?? 0) / (height ?? 0)}>
        <EdgeImage
          src={previewUrl ?? url}
          alt={name ?? undefined}
          width={width ?? 1200}
          className={classes.image}
        />
      </AspectRatio>
      <Menu position="bottom-end">
        <Menu.Target>
          <ActionIcon size="lg" className={classes.actions} variant="transparent" p={0}>
            <IconDotsVertical
              size={24}
              color="#fff"
              style={{ filter: `drop-shadow(0 0 2px #000)` }}
            />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <DeleteImage imageId={id} onSuccess={(id) => removeImage(id)}>
            {({ onClick, isLoading }) => (
              <Menu.Item color="red" onClick={onClick}>
                Delete image
              </Menu.Item>
            )}
          </DeleteImage>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}

function ImageUpload({ url, name, uuid }: ImageUpload) {
  const { classes, cx } = useStyles();
  const items = useCFUploadStore((state) => state.items);
  const trackedFile = items.find((x) => x.meta.uuid === uuid);
  console.log({ items });
  return (
    <div className={classes.container}>
      <EdgeImage src={url} alt={name ?? undefined} />
      <Group>
        <Badge>{trackedFile?.progress}</Badge>
        <Badge>{trackedFile?.timeRemaining}</Badge>
      </Group>
    </div>
  );
}

const useStyles = createStyles((theme) => ({
  container: {
    position: 'relative',
  },
  image: {
    minWidth: '100%',
  },
  actions: {
    position: 'absolute',
    top: theme.spacing.sm,
    right: theme.spacing.sm,
  },
}));
