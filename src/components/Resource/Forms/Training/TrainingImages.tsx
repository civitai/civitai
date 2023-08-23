import {
  ActionIcon,
  Button,
  Center,
  Checkbox,
  createStyles,
  Group,
  Image,
  Loader,
  Pagination,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { FileWithPath } from '@mantine/dropzone';
import { showNotification, updateNotification } from '@mantine/notifications';
import { ModelFileVisibility } from '@prisma/client';
import { IconCheck, IconTrash, IconX } from '@tabler/icons-react'; // import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import { isEqual } from 'lodash-es';
import { useEffect, useState } from 'react';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { goBack, goNext } from '~/components/Resource/Forms/Training/TrainingCommon';
import { UploadType } from '~/server/common/enums';
import { IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { ModelById } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { bytesToKB } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

// zustand

interface imageDataType {
  name: string;
  type: string;
  url: string;
  caption: string;
}

const useStyles = createStyles(() => ({
  imgOverlay: {
    position: 'relative',
    '&:hover .trashIcon': {
      display: 'initial',
    },
  },
  trash: {
    display: 'none',
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 10,
    margin: 4,
  },
}));

// TODO [bw] is this enough? do we want jfif and webp?
const imageExts: { [key: string]: string } = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  // webp: 'image/webp',
};

export const TrainingFormImages = ({ model }: { model: ModelById }) => {
  const [imageList, setImageList] = useState<imageDataType[]>([]);
  const [initialImageList, setInitialImageList] = useState<imageDataType[]>([]);
  const [page, setPage] = useState(1);
  const [ownRights, setOwnRights] = useState<boolean>(false);
  const [shareDataset, setShareDataset] = useState<boolean>(false);
  const [zipping, setZipping] = useState<boolean>(false);
  const [loadingZip, setLoadingZip] = useState<boolean>(false);
  const theme = useMantineTheme();
  const { classes, cx } = useStyles();
  const queryUtils = trpc.useContext();

  const thisModelVersion = model.modelVersions[0];
  const notificationId = `${thisModelVersion.id}-uploading-data-notification`;

  const { upload, getStatus: getUploadStatus } = useS3UploadStore();
  const { uploading } = getUploadStatus((file) => file.meta?.versionId === thisModelVersion.id);

  useEffect(() => {
    // is there any way to generate a file download url given the one we already have?
    // async function parseExisting(ef: (typeof thisModelVersion.files)[number]) {
    async function parseExisting() {
      const url = createModelFileDownloadUrl({
        versionId: thisModelVersion.id,
        type: 'Training Data',
      });
      const result = await fetch(url);
      if (!result.ok) {
        return;
      }
      const blob = await result.blob();
      const zipFile = new File([blob], `${thisModelVersion.id}_training_data.zip`, {
        type: blob.type,
      });
      return await handleZip(zipFile, false);
    }
    const existingDataFile = thisModelVersion.files.find((f) => f.type === 'Training Data');
    if (existingDataFile) {
      setLoadingZip(true);
      parseExisting().then((files) => {
        if (files) {
          const flatFiles = files.flat();
          setImageList(flatFiles);
          setInitialImageList(flatFiles.map((d) => ({ ...d })));
        }
        setLoadingZip(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const thisStep = 2;
  const maxImgPerPage = 9;

  const handleZip = async (f: FileWithPath, showNotif = true) => {
    // could set loadingZip here too
    const parsedFiles: imageDataType[] = [];
    const zipReader = new JSZip();
    // zipReader.loadAsync(f).then((zData) => {
    const zData = await zipReader.loadAsync(f);
    await Promise.all(
      Object.entries(zData.files).map(async ([zname, zf]) => {
        // - we could read the type here with some crazy blob/hex inspecting
        const fileSplit = zname.split('.');
        const fileExt = fileSplit.pop() || '';
        const baseFileName = fileSplit.join('.');
        if (fileExt in imageExts) {
          const imgBlob = await zf.async('blob');
          const czFile = zipReader.file(`${baseFileName}.txt`);
          let captionStr = '';
          if (czFile) captionStr = await czFile.async('string');
          parsedFiles.push({
            name: zname,
            type: imageExts[fileExt],
            url: URL.createObjectURL(imgBlob),
            caption: captionStr,
          });
        }
      })
    );

    if (showNotif) {
      if (parsedFiles.length > 0) {
        showSuccessNotification({
          title: 'Zip parsed successfully!',
          message: `Found ${parsedFiles.length} images.`,
          autoClose: 3000,
        });
      } else {
        showErrorNotification({
          error: new Error('Could not find any valid files in zip.'),
        });
      }
    }

    return parsedFiles;
  };

  const handleDrop = async (fileList: FileWithPath[]) => {
    // blob:http://localhost:3000/3949be19-8afa-41ee-9cc6-4773e6a0ab73
    console.log(fileList);

    const newFiles = await Promise.all(
      fileList.map(async (f) => {
        if (f.type === 'application/zip') {
          return await handleZip(f);
        } else {
          return { name: f.name, type: f.type, url: URL.createObjectURL(f), caption: '' };
        }
      })
    );
    setImageList(imageList.concat(newFiles.flat()));
  };

  // TODO [bw] should this be doing an update if it exists instead?
  const createFileMutation = trpc.modelFile.create.useMutation({
    async onSuccess(result) {
      console.log(result);

      updateNotification({
        id: notificationId,
        icon: <IconCheck size={18} />,
        color: 'teal',
        title: 'Upload complete!',
        message: '',
        autoClose: 3000,
        disallowClose: false,
      });

      await queryUtils.modelVersion.getById.invalidate({ id: result.modelVersion.id });
      await queryUtils.model.getById.invalidate({ id: model.id });

      setZipping(false);

      goNext(model.id, thisStep);
    },
    onError(error) {
      setZipping(false);
      updateNotification({
        id: notificationId,
        icon: <IconX size={18} />,
        color: 'red',
        title: 'Failed to upload archive.',
        message: error.message,
      });
    },
  });

  const handleNext = async () => {
    if (isEqual(imageList, initialImageList)) {
      return goNext(model.id, thisStep);
    }

    if (imageList.length) {
      setZipping(true);
      const zip = new JSZip();

      await Promise.all(
        imageList.map(async (imgData, idx) => {
          const filenameBase = String(idx).padStart(3, '0');
          imgData.caption.length > 0 && zip.file(`${filenameBase}.txt`, imgData.caption);

          const imgBlob = await fetch(imgData.url).then((res) => res.blob());

          // TODO [bw] unregister here

          zip.file(`${filenameBase}.${imgData.type.split('/').pop()}`, imgBlob);
        })
      );
      // TODO [bw] handle error
      zip.generateAsync({ type: 'blob' }).then(async (content) => {
        // saveAs(content, 'example.zip');
        // save to ModelFile with type training data

        const blobFile = new File([content], `${thisModelVersion.id}_training_data.zip`, {
          type: 'application/zip',
        });
        console.log(blobFile);

        showNotification({
          id: notificationId,
          loading: true,
          autoClose: false,
          disallowClose: true,
          title: 'Creating and uploading archive',
          message: `Packaging ${imageList.length} images...`,
        });

        try {
          await upload(
            {
              file: blobFile,
              type: UploadType.TrainingImages,
              meta: {
                versionId: thisModelVersion.id,
                ownRights,
                shareDataset,
                numImages: imageList.length,
                numCaptions: imageList.filter((i) => i.caption.length > 0).length,
              },
            },
            async ({ meta, size, ...result }) => {
              console.log(meta);
              console.log(size);
              console.log(result);
              const { versionId, ...metadata } = meta as {
                versionId: number;
              };
              if (versionId) {
                try {
                  await createFileMutation.mutateAsync({
                    ...result,
                    sizeKB: bytesToKB(size),
                    modelVersionId: versionId,
                    type: 'Training Data',
                    visibility:
                      ownRights && shareDataset
                        ? ModelFileVisibility.Public
                        : ownRights
                        ? ModelFileVisibility.Sensitive
                        : ModelFileVisibility.Private,
                    metadata,
                  });
                } catch (e: unknown) {
                  console.log(e);
                  setZipping(false);
                  updateNotification({
                    id: notificationId,
                    icon: <IconX size={18} />,
                    color: 'red',
                    title: 'Failed to upload archive.',
                    message: '',
                  });
                }
              }
            }
          );
        } catch (e) {
          setZipping(false);
          updateNotification({
            id: notificationId,
            icon: <IconX size={18} />,
            color: 'red',
            title: 'Failed to upload archive.',
            message: e instanceof Error ? e.message : '',
          });
        }
      });
    } else {
      // no images given. could show a takeover or form inline error instead.
      showNotification({
        icon: <IconX size={18} />,
        color: 'red',
        title: 'No images provided',
        message: 'Must select at least 1 image.',
      });
    }
  };
  const totalCaptioned = imageList.filter((i) => i.caption && i.caption.length > 0).length;

  return (
    <>
      <Stack>
        <div>
          <Text>You can upload your images and caption them here.</Text>
          {/* TODO [bw] add links */}
          {/* <Text variant="link" component={NextLink} href="/models/create" inline> */}
          <Text>Or, you can *upload an existing dataset*. See our *training guidelines*.</Text>
        </div>
        <div>
          <ImageDropzone
            mt="md"
            onDrop={handleDrop}
            label="Drag images (or a zip file) here or click to select files"
            description={
              <Text mt="xs" fz="sm" color={theme.colors.red[5]}>
                Changes made here are not saved until you hit &quot;Next&quot;
              </Text>
            }
            max={1000}
            // loading={isLoading}
            count={100}
            accept={[...IMAGE_MIME_TYPE, 'application/zip']}
          />
        </div>

        {imageList.length > 0 && (
          <Group mt="md" position="apart">
            <Group>
              {/*perhaps open a modal here to confirm*/}
              <Button compact color="red" onClick={() => setImageList([])}>
                <IconTrash size={16} />
                <Text inline ml={4}>
                  Clear All
                </Text>
              </Button>
              <Text
                color={
                  totalCaptioned === 0
                    ? theme.colors.red[5]
                    : totalCaptioned < imageList.length
                    ? theme.colors.orange[5]
                    : theme.colors.green[5]
                }
              >
                {`${totalCaptioned} / ${imageList.length} captioned`}
              </Text>
            </Group>

            {imageList.length > maxImgPerPage && (
              <Pagination
                page={page}
                onChange={setPage}
                total={Math.ceil(imageList.length / maxImgPerPage)}
              />
            )}
          </Group>
        )}

        {loadingZip ? (
          <Center style={{ flexDirection: 'column' }}>
            <Loader />
            <Text>Parsing existing images...</Text>
          </Center>
        ) : (
          // nb: if we want to break out of container, add margin: 0 calc(50% - 45vw);
          <SimpleGrid cols={3} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
            {imageList
              .slice((page - 1) * maxImgPerPage, (page - 1) * maxImgPerPage + maxImgPerPage)
              .map((imgData, index) => {
                console.log(imgData);
                return (
                  <Stack
                    key={index}
                    // style={{ justifyContent: 'center', alignItems: 'center', position: 'relative' }}
                    style={{ justifyContent: 'flex-start' }}
                  >
                    {/* TODO [bw] probably lightbox here or something similar */}
                    <div className={classes.imgOverlay}>
                      <ActionIcon
                        color="red"
                        variant="filled"
                        size="md"
                        onClick={() => {
                          const newLen = imageList.length - 1;
                          setImageList(imageList.filter((i) => i.url !== imgData.url));
                          if (
                            page === Math.ceil(imageList.length / maxImgPerPage) &&
                            newLen % maxImgPerPage === 0
                          )
                            setPage(page - 1);
                        }}
                        className={cx(classes.trash, 'trashIcon')}
                      >
                        <IconTrash />
                      </ActionIcon>
                      <Image
                        alt={imgData.name}
                        src={imgData.url}
                        imageProps={{
                          style: {
                            height: '250px',
                            // if we want to show full image, change objectFit to contain
                            objectFit: 'cover',
                            // object-position: top;
                            width: '100%',
                          },
                          // onLoad: () => URL.revokeObjectURL(imageUrl)
                        }}
                      />
                    </div>
                    <Textarea
                      placeholder="Enter caption data..."
                      autosize
                      minRows={1}
                      maxRows={4}
                      value={imgData.caption}
                      // onChange={(event) => setImageList(imageList.map((i) => i.url === imgData.url ? {...i, caption: event.currentTarget.value} : i))}
                      onChange={(event) => {
                        imgData.caption = event.currentTarget.value;
                        setImageList([...imageList]);
                      }}
                    />
                  </Stack>
                );
              })}
          </SimpleGrid>
        )}

        {imageList.length > 0 && (
          <Paper mt="xl" mb="md" radius="md" p="xl" withBorder>
            <Stack>
              <Title order={4}>Data Ownership and Sharing</Title>
              {/* TODO [bw] link for storage policy */}
              <Text fz="sm">
                Your dataset is temporarily stored for the purposes of training. After training is
                complete, the dataset is removed. By default, it is not public. Read our dataset
                storage policy *here*.
              </Text>
              <Checkbox
                label="I own the rights to all these images"
                checked={ownRights}
                onChange={(event) => {
                  setOwnRights(event.currentTarget.checked);
                  !event.currentTarget.checked && setShareDataset(false);
                }}
              />
              <Checkbox
                label="I want to share my dataset"
                disabled={!ownRights}
                checked={shareDataset}
                onChange={(event) => setShareDataset(event.currentTarget.checked)}
              />
            </Stack>
          </Paper>
        )}
      </Stack>
      {/* TODO [bw] add a warning here, because state will disappear. optionally use a context manager to preserve this, and extra optionally use webdb or the like */}
      <Group position="right">
        <Button variant="default" onClick={() => goBack(model.id, thisStep)}>
          Back
        </Button>
        <Button onClick={handleNext} loading={zipping || uploading > 0}>
          Next
        </Button>
      </Group>
    </>
  );
};
