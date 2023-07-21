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
  BadgeProps,
  Button,
  Skeleton,
  Loader,
} from '@mantine/core';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  IconDotsVertical,
  IconInfoCircle,
  IconTrash,
  IconX,
  IconExclamationMark,
  IconExclamationCircle,
  IconCheck,
} from '@tabler/icons-react';
import { DeleteImage } from '~/components/Image/DeleteImage/DeleteImage';
import { useCFUploadStore } from '~/store/cf-upload.store';
import { EditImageDrawer } from '~/components/Post/Edit/EditImageDrawer';
import { PostEditImage } from '~/server/controllers/post.controller';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { POST_IMAGE_LIMIT } from '~/server/common/constants';
import { ImageIngestionStatus } from '@prisma/client';
import { isDefined } from '~/utils/type-guards';
import {
  ImageIngestionProvider,
  useImageIngestionContext,
} from '~/components/Image/Ingestion/ImageIngestionProvider';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { useEditPostContext, ImageUpload, ImageBlocked } from './EditPostProvider';
import {
  postImageTransmitter,
  usePostImageTransmitterStore,
} from '~/store/post-image-transmitter.store';

export function EditPostImages({ max }: { max?: number }) {
  max ??= POST_IMAGE_LIMIT;
  const transmittedFiles = usePostImageTransmitterStore((state) => state.data);
  const postId = useEditPostContext((state) => state.id);
  const modelVersionId = useEditPostContext((state) => state.modelVersionId);
  const upload = useEditPostContext((state) => state.upload);
  const images = useEditPostContext((state) => state.images);

  const imageIds = images
    .map((x) => (x.type === 'image' ? x.data.id : undefined))
    .filter(isDefined);

  const handleDrop = async (files: File[]) => upload({ postId, modelVersionId }, files);

  // do something with files that were set externally
  // this will duplicate the images being uploaded in dev due to reactStrictMode
  useEffect(() => {
    if (transmittedFiles) {
      handleDrop(transmittedFiles);
      postImageTransmitter.setData(undefined);
    }
    return () => postImageTransmitter.setData(undefined);
  }, [transmittedFiles]);

  return (
    <Stack>
      <ImageDropzone onDrop={handleDrop} count={images.length} max={max} />
      <ImageIngestionProvider ids={imageIds}>
        <Stack>
          {images.map(({ type, data }, index) => (
            <Fragment key={index}>
              {type === 'image' && <ImageController image={data} />}
              {type === 'upload' && <ImageUpload {...data} />}
              {type === 'blocked' && <ImageBlocked {...data} />}
            </Fragment>
          ))}
        </Stack>
      </ImageIngestionProvider>
      <EditImageDrawer />
    </Stack>
  );
}

function ImageController({
  image: {
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
    resourceHelper,
    blockedFor,
  },
}: {
  image: PostEditImage;
}) {
  const { classes, cx } = useStyles();
  const [withBorder, setWithBorder] = useState(false);
  const removeImage = useEditPostContext((state) => state.removeImage);
  const setSelectedImageId = useEditPostContext((state) => state.setSelectedImageId);
  const handleSelectImageClick = () => setSelectedImageId(id);

  const data = useImageIngestionContext(useCallback((state) => state.images[id] ?? {}, [id]));
  const pending = useImageIngestionContext(
    useCallback((state) => state.pending[id] ?? { attempts: 0, success: false }, [id])
  );
  const isBlocked = data?.ingestion === ImageIngestionStatus.Blocked;
  const isLoading = pending.attempts < 5 && !pending.success;
  const loadingFailed = !isLoading && !data;

  return (
    <Card className={classes.container} withBorder={withBorder} p={0}>
      <EdgeImage
        src={previewUrl ?? url}
        alt={name ?? undefined}
        width={width ?? 1200}
        onLoad={() => setWithBorder(true)}
        className={cx({ [classes.blocked]: isBlocked })}
      />

      {(!data || data.ingestion !== ImageIngestionStatus.Blocked) && (
        <>
          {isLoading ? (
            <Group p="xs" sx={{ width: '100%' }} spacing="xs" noWrap>
              <Loader size={20} />
              <Skeleton height={20} />
            </Group>
          ) : loadingFailed ? (
            <Alert color="yellow" m="xs">
              There are no tags associated with this image yet. Tags will be assigned to this image
              soon.
            </Alert>
          ) : !!data.tags?.length ? (
            <VotableTags
              entityType="image"
              entityId={id}
              p="xs"
              canAdd
              canAddModerated
              tags={data.tags}
            />
          ) : null}
          <>
            <Group className={classes.actions}>
              {meta ? (
                <Badge {...readyBadgeProps} onClick={handleSelectImageClick}>
                  Generation Data
                </Badge>
              ) : (
                <Badge {...warningBadgeProps} onClick={handleSelectImageClick}>
                  Missing Generation Data
                </Badge>
              )}
              {resourceHelper.length ? (
                <Badge {...readyBadgeProps} onClick={handleSelectImageClick}>
                  Resources: {resourceHelper.length}
                </Badge>
              ) : (
                <Badge {...blockingBadgeProps} onClick={handleSelectImageClick}>
                  Missing Resources
                </Badge>
              )}
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon size="lg" variant="transparent" p={0}>
                    <IconDotsVertical
                      size={24}
                      color="#fff"
                      style={{ filter: `drop-shadow(0 0 2px #000)` }}
                    />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item onClick={handleSelectImageClick}>Edit image</Menu.Item>
                  <DeleteImage imageId={id} onSuccess={(id) => removeImage(id)}>
                    {({ onClick, isLoading }) => (
                      <Menu.Item color="red" onClick={onClick}>
                        Delete image
                      </Menu.Item>
                    )}
                  </DeleteImage>
                </Menu.Dropdown>
              </Menu>
            </Group>
          </>
        </>
      )}
      {data?.ingestion === ImageIngestionStatus.Blocked && (
        <Card
          radius={0}
          p={0}
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%,-50%)',
            minWidth: 300,
          }}
        >
          <Alert
            color="red"
            radius={0}
            title={
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
                      <Code color="red">{blockedFor}</Code>
                    </Stack>
                  </Popover.Dropdown>
                </Popover>
                <Text>TOS Violation</Text>
              </Group>
            }
          >
            <Stack align="flex-end" spacing={0}>
              <Text>This image has been flagged as a TOS violation.</Text>
              <DeleteImage imageId={id} onSuccess={(id) => removeImage(id)} skipConfirm>
                {({ onClick, isLoading }) => (
                  <Button onClick={onClick} loading={isLoading}>
                    Ok
                  </Button>
                )}
              </DeleteImage>
            </Stack>
          </Alert>
        </Card>
      )}
    </Card>
  );
}

function ImageUpload({ url, name, uuid, status, message, file }: ImageUpload) {
  const { classes, cx } = useStyles();
  const items = useCFUploadStore((state) => state.items);
  const trackedFile = items.find((x) => x.file === file);
  const removeFile = useEditPostContext((state) => state.removeFile);
  const hasError =
    trackedFile && (trackedFile.status === 'error' || trackedFile.status === 'aborted');

  useEffect(() => {
    if (trackedFile?.status === 'dequeued') removeFile(uuid);
  }, [trackedFile?.status]); //eslint-disable-line

  return (
    <Card className={classes.container} withBorder p={0}>
      <EdgeImage src={url} alt={name ?? undefined} />
      {trackedFile && (
        <Alert
          radius={0}
          p="sm"
          color={hasError ? 'red' : undefined}
          variant={hasError ? 'filled' : undefined}
          className={cx(classes.footer, { [classes.ambient]: !hasError })}
        >
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
            {hasError ? (
              <ActionIcon color="red" onClick={() => removeFile(uuid)}>
                <IconX />
              </ActionIcon>
            ) : trackedFile.status !== 'success' ? (
              <ActionIcon onClick={trackedFile.abort}>
                <IconX />
              </ActionIcon>
            ) : null}
          </Group>
        </Alert>
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

function ImageBlocked({ blockedFor, tags, uuid }: ImageBlocked) {
  const { classes, cx } = useStyles();
  const removeFile = useEditPostContext((state) => state.removeFile);
  return (
    <Card className={classes.container} withBorder p={0}>
      <Alert
        color="red"
        styles={{ label: { width: '100%' } }}
        title={
          <Group noWrap position="apart" sx={{ width: '100%' }}>
            <Group spacing={4} noWrap>
              <Popover position="top" withinPortal withArrow width={300}>
                <Popover.Target>
                  <ActionIcon>
                    <IconInfoCircle />
                  </ActionIcon>
                </Popover.Target>
                <Popover.Dropdown>
                  <Stack spacing="xs">
                    <Text size="xs" weight={500}>
                      Blocked for
                    </Text>
                    <Code color="red">{blockedFor}</Code>
                    <Group spacing="xs">
                      {tags
                        ?.filter((x) => x.type === 'Moderation')
                        .map((x) => (
                          <Badge key={x.name} color="red">
                            {x.name}
                          </Badge>
                        ))}
                    </Group>
                  </Stack>
                </Popover.Dropdown>
              </Popover>
              <Text>TOS Violation</Text>
            </Group>
            <ActionIcon color="red" onClick={() => removeFile(uuid)}>
              <IconX />
            </ActionIcon>
          </Group>
        }
      >
        <Text>
          The image you uploaded was determined to violate our TOS and has been completely removed
          from our service
        </Text>
      </Alert>
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
      minHeight: 200,
    },
    blocked: {
      opacity: 0.3,
    },
    actions: {
      position: 'absolute',
      top: theme.spacing.sm,
      right: theme.spacing.sm,
    },
    header: {
      position: 'absolute',
      top: 0,
      right: 0,
      left: 0,
    },
    floatingBadge: {
      color: 'white',
      backdropFilter: 'blur(7px)',
      boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
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
    error: {
      backgroundColor: theme.fn.rgba(
        theme.colorScheme === 'dark' ? theme.colors.red[8] : theme.colors.red[6],
        0.5
      ),
    },
  };
});

const sharedBadgeProps: Partial<BadgeProps> = {
  sx: () => ({ cursor: 'pointer' }),
  variant: 'filled',
};

const readyBadgeProps: Partial<BadgeProps> = {
  ...sharedBadgeProps,
  color: 'green',
  leftSection: (
    <Center>
      <IconCheck size={16} />
    </Center>
  ),
};

const warningBadgeProps: Partial<BadgeProps> = {
  ...sharedBadgeProps,
  color: 'yellow',
  leftSection: (
    <Center>
      <IconExclamationMark size={16} />
    </Center>
  ),
};

const blockingBadgeProps: Partial<BadgeProps> = {
  ...sharedBadgeProps,
  color: 'red',
  leftSection: (
    <Center>
      <IconExclamationCircle size={16} />
    </Center>
  ),
};
