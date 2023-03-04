import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { trpc } from '~/utils/trpc';
import { useEditPostContext, ImageUpload } from './EditPostProvider';
import {
  createStyles,
  Stack,
  Menu,
  ActionIcon,
  Group,
  Badge,
  Progress,
  Text,
  Card,
  Alert,
  Center,
  Popover,
  Code,
} from '@mantine/core';
import { PostImage } from '~/server/selectors/post.selector';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { Fragment } from 'react';
import { IconDotsVertical, IconInfoCircle, IconTrash, IconX } from '@tabler/icons';
import { DeleteImage } from '~/components/Image/DeleteImage/DeleteImage';
import { useCFUploadStore } from '~/store/cf-upload.store';

export function EditPostImages() {
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
    <Card className={classes.container} withBorder p={0}>
      <EdgeImage src={previewUrl ?? url} alt={name ?? undefined} width={width ?? 1200} />
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
    </Card>
  );
}

function ImageUpload({ url, name, uuid, status, message }: ImageUpload) {
  const { classes, cx } = useStyles();
  const items = useCFUploadStore((state) => state.items);
  const trackedFile = items.find((x) => x.meta.uuid === uuid);
  console.log({ trackedFile });
  const removeFile = useEditPostContext((state) => state.removeFile);
  return (
    <Card className={classes.container} withBorder p={0}>
      <EdgeImage src={url} alt={name ?? undefined} />
      {status === 'uploading' && trackedFile && (
        <Card radius={0} p="sm" className={cx(classes.footer, classes.ambient)}>
          <Group noWrap>
            <Text>{trackedFile.status}</Text>
            <Progress
              sx={{ flex: 1 }}
              size="xl"
              value={trackedFile.progress}
              label={`${Math.floor(trackedFile.progress)}%`}
              color={trackedFile.progress < 100 ? 'blue' : 'green'}
              striped
              animate
            />
            {trackedFile.status === 'error' && (
              <ActionIcon color="red" onClick={() => removeFile(uuid)}>
                <IconX />
              </ActionIcon>
            )}
          </Group>
        </Card>
      )}
      {status === 'blocked' && (
        <>
          <ActionIcon
            className={classes.actions}
            onClick={() => removeFile(uuid)}
            color="red"
            variant="filled"
            size="xl"
          >
            <IconTrash />
          </ActionIcon>
          <Card className={classes.footer} radius={0} p={0}>
            <Alert color="red" radius={0}>
              <Center>
                <Group spacing={4}>
                  <Popover position="top" withinPortal withArrow>
                    <Popover.Target>
                      <ActionIcon>
                        <IconInfoCircle />
                      </ActionIcon>
                    </Popover.Target>
                    <Popover.Dropdown>
                      <Stack spacing={0}>
                        <Text size="xs" weight={500}>
                          Blocked for
                        </Text>
                        <Code color="red">{message}</Code>
                      </Stack>
                    </Popover.Dropdown>
                  </Popover>
                  <Text>TOS Violation</Text>
                </Group>
              </Center>
            </Alert>
          </Card>
        </>
      )}
    </Card>
  );
}

const useStyles = createStyles((theme) => {
  return {
    container: {
      position: 'relative',
      background: theme.colors.dark[9],
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
    },
    actions: {
      position: 'absolute',
      top: theme.spacing.sm,
      right: theme.spacing.sm,
    },
    footer: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      left: 0,
    },
    ambient: {
      backgroundColor: theme.fn.rgba(theme.colorScheme === 'dark' ? '#000' : '#fff', 0.5),
    },
  };
});
