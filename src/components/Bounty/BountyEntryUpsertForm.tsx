import {
  Button,
  Group,
  Stack,
  Text,
  Title,
  SimpleGrid,
  Paper,
  ActionIcon,
  Progress,
  Anchor,
  Tooltip,
  Switch,
  Input,
  ThemeIcon,
  HoverCard,
} from '@mantine/core';
import { IconInfoCircle, IconQuestionMark, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { BackButton, NavigateBack } from '~/components/BackButton/BackButton';
import { Form, InputMultiFileUpload, InputRTE, useForm } from '~/libs/form';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE, ZIP_MIME_TYPE } from '~/server/common/mime-types';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { z } from 'zod';
import { BountyEntryGetById, BountyGetById } from '~/types/router';
import {
  BountyEntryFileMeta,
  bountyEntryFileSchema,
  upsertBountyEntryInputSchema,
} from '~/server/schema/bounty-entry.schema';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { getBountyCurrency, getMainBountyAmount } from '~/components/Bounty/bounty.utils';
import { BountyEntryMode, BountyType, Currency } from '@prisma/client';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { formatKBytes } from '~/utils/number-helpers';
// import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';

const dropzoneOptionsByModelType: Record<BountyType, string[] | Record<string, string[]>> = {
  ModelCreation: {
    'application/octet-stream': ['.ckpt', '.pt', '.safetensors', '.bin', '.onnx'],
    'application/zip': ['.zip'],
    'application/x-yaml': ['.yaml', '.yml'],
  },
  LoraCreation: {
    'application/octet-stream': ['.ckpt', '.pt', '.safetensors', '.bin'],
    'application/zip': ['.zip'],
    'application/x-yaml': ['.yaml', '.yml'],
  },
  EmbedCreation: {
    'application/octet-stream': ['.ckpt', '.pt', '.safetensors', '.bin'],
    'application/zip': ['.zip'],
  },
  DataSetCreation: ZIP_MIME_TYPE,
  DataSetCaption: ZIP_MIME_TYPE,
  ImageCreation: [...IMAGE_MIME_TYPE, ...ZIP_MIME_TYPE],
  VideoCreation: [...VIDEO_MIME_TYPE, ...ZIP_MIME_TYPE],
  Other: ZIP_MIME_TYPE,
};

const formSchema = z
  .object({
    sampleFiles: z.array(bountyEntryFileSchema).optional(),
    bountyFiles: z.array(bountyEntryFileSchema).min(1),
    unlockAmount: z.number().int().min(1).optional(),
  })
  .merge(
    upsertBountyEntryInputSchema.omit({
      images: true,
      bountyId: true,
      files: true,
    })
  );

export function BountyEntryUpsertForm({ bountyEntry, bounty }: Props) {
  const router = useRouter();
  const { files: imageFiles, uploadToCF, removeImage } = useCFImageUpload();
  const queryUtils = trpc.useContext();

  const currency = getBountyCurrency(bounty);
  const maxAmount = getMainBountyAmount(bounty);
  const openEntry = bounty.entryMode === BountyEntryMode.Open;

  const handleDropImages = async (droppedFiles: File[]) => {
    for (const file of droppedFiles) {
      uploadToCF(file);
    }
  };

  const form = useForm({
    schema: formSchema,
    defaultValues: {
      ...bountyEntry,
      bountyFiles: (bountyEntry?.files ?? [])
        .filter((file) => !!file.metadata.unlockAmount)
        .map((f) => ({ ...f, url: f.url || '' })),
      sampleFiles: (bountyEntry?.files ?? [])
        .filter((file) => !file.metadata.unlockAmount)
        .map((f) => ({ ...f, url: f.url || '' })),
      unlockAmount:
        (bountyEntry?.files ?? []).filter((file) => !!file.metadata.unlockAmount)[0]?.metadata
          .unlockAmount ?? 1,
    },
    shouldUnregister: false,
  });

  const [creating, setCreating] = useState(false);
  const bountyEntryCreateMutation = trpc.bountyEntry.create.useMutation();

  const handleSubmit = ({
    bountyFiles,
    sampleFiles = [],
    unlockAmount,
    ...data
  }: z.infer<typeof formSchema>) => {
    const filteredImages = imageFiles
      .filter((file) => file.status === 'success')
      .map(({ id, url, ...file }) => ({ ...file, url: id }));

    const files = [
      ...sampleFiles,
      ...bountyFiles.map((file) => ({
        ...file,
        metadata: {
          ...file.metadata,
          unlockAmount: openEntry ? unlockAmount : maxAmount,
          benefactorsOnly: openEntry ? file.metadata.benefactorsOnly : true,
        },
      })),
    ];

    bountyEntryCreateMutation.mutate(
      { ...data, bountyId: bounty.id, images: filteredImages, files },
      {
        async onSuccess() {
          await queryUtils.bounty.getEntries.invalidate({ id: bounty.id });
          await router.push(`/bounties/${bounty.id}`);
        },
        onError(error) {
          showErrorNotification({
            title: 'Failed to create bounty',
            error: new Error(error.message),
          });
        },
      }
    );
  };

  const acceptedFileTypes =
    dropzoneOptionsByModelType[bounty.type] ?? dropzoneOptionsByModelType.Other;

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing="xl">
        <Group spacing="md">
          <BackButton url={`/bounties/${bounty.id}`} />
          <Title inline>Submit new entry</Title>
        </Group>
        <InputRTE
          name="description"
          label="Notes"
          editorSize="xl"
          labelProps={{ size: 'xl' }}
          description="Please describe your entry in detail. This will help participants understand what you are offering and how to use it."
          includeControls={['colors', 'formatting', 'heading', 'link', 'list']}
          stickyToolbar
        />
        <Input.Wrapper
          label="Example Images"
          labelProps={{ size: 'xl' }}
          description="Please add at least 1 image to your bounty entry. This will serve as a reference point for participants and will also be used as your cover image."
          withAsterisk
        >
          <ImageDropzone
            label="Drag & drop images here or click to browse"
            onDrop={handleDropImages}
            count={imageFiles.length}
            mt={5}
            orientation="vertical"
            accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
          />
        </Input.Wrapper>
        {imageFiles.length > 0 && (
          <SimpleGrid
            spacing="sm"
            breakpoints={[
              { minWidth: 'xs', cols: 1 },
              { minWidth: 'sm', cols: 3 },
              { minWidth: 'md', cols: 4 },
            ]}
          >
            {imageFiles
              .slice()
              .reverse()
              .map((file) => (
                <Paper
                  key={file.id}
                  radius="sm"
                  p={0}
                  sx={{ position: 'relative', overflow: 'hidden', height: 332 }}
                  withBorder
                >
                  {file.status === 'success' ? (
                    <>
                      <EdgeMedia
                        placeholder="empty"
                        src={file.id}
                        alt={file.name ?? undefined}
                        style={{ objectFit: 'cover', height: '100%' }}
                      />
                      <div style={{ position: 'absolute', top: 12, right: 12 }}>
                        <ActionIcon
                          variant="filled"
                          size="lg"
                          color="red"
                          onClick={() => removeImage(file.id)}
                        >
                          <IconTrash size={26} strokeWidth={2.5} />
                        </ActionIcon>
                      </div>
                      {file.type === 'image' && (
                        <div style={{ position: 'absolute', bottom: 12, right: 12 }}>
                          <ImageMetaPopover meta={file.meta}>
                            <ActionIcon variant="light" color="dark" size="lg">
                              <IconInfoCircle color="white" strokeWidth={2.5} size={26} />
                            </ActionIcon>
                          </ImageMetaPopover>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <MediaHash {...file} />
                      <Progress
                        size="xl"
                        value={file.progress}
                        label={`${Math.floor(file.progress)}%`}
                        color={file.progress < 100 ? 'blue' : 'green'}
                        striped
                        animate
                      />
                    </>
                  )}
                </Paper>
              ))}
          </SimpleGrid>
        )}
        <Group spacing="md" align="flex-start" sx={{ '& > *': { flexGrow: 1 } }}>
          <InputMultiFileUpload
            name="sampleFiles"
            label={
              <Group spacing={8} noWrap>
                <Text size="xl">Sample Files</Text>
                <HoverCard width={300}>
                  <HoverCard.Target>
                    <ThemeIcon radius="xl" size="xs" color="gray">
                      <IconQuestionMark />
                    </ThemeIcon>
                  </HoverCard.Target>
                  <HoverCard.Dropdown>
                    <Stack spacing={4}>
                      <Text size="md" color="yellow">
                        What&apos;s this?
                      </Text>
                      <Text size="sm">
                        Sample Files are files that you&apos;d like to share with Supporters
                        reviewing your entry that might help them get a better idea of what
                        you&apos;ve included with your bounty
                      </Text>
                    </Stack>
                  </HoverCard.Dropdown>
                </HoverCard>
              </Group>
            }
            orientation="vertical"
            labelProps={{ size: 'xl' }}
            dropzoneProps={{
              maxFiles: 10,
              accept: [...IMAGE_MIME_TYPE, ...ZIP_MIME_TYPE],
            }}
            renderItem={(file, onRemove) => {
              return (
                <Paper key={file.id} p={16} radius="md" w="100%" bg="dark.4">
                  <Stack>
                    <Group position="apart">
                      <Stack spacing={0}>
                        {bountyEntry && file.id ? (
                          <Anchor
                            href={`/api/download/attachments/${file.id}`}
                            lineClamp={1}
                            download
                          >
                            {file.name}
                          </Anchor>
                        ) : (
                          <Text size="sm" weight={500} lineClamp={1}>
                            {file.name}
                          </Text>
                        )}
                        <Text color="dimmed" size="xs">
                          {formatKBytes(file.sizeKB)}
                        </Text>
                      </Stack>
                      <Tooltip label="Remove">
                        <ActionIcon
                          size="md"
                          color="red"
                          variant="light"
                          radius="xl"
                          onClick={onRemove}
                        >
                          <IconTrash size="1rem" />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                    {/* <NumberInputWrapper
                      label="Unlock amount"
                      description="Only after this amount of awards is reached, the file will be unlocked. For sample files, it's always safest to use 0."
                      icon={<CurrencyIcon currency={currency} size={18} />}
                      format={currency !== Currency.BUZZ ? 'currency' : undefined}
                      currency={currency}
                      value={unlockAmount}
                      max={getMainBountyAmount(bounty)}
                      onChange={(value) => {
                        onUpdate({
                          ...file,
                          metadata: {
                            ...metadata,
                            unlockAmount: value,
                          },
                        });
                      }}
                    /> */}
                  </Stack>
                </Paper>
              );
            }}
          />
          <InputMultiFileUpload
            name="bountyFiles"
            label={
              <Group spacing={8} noWrap>
                <Text size="xl">Bounty Files</Text>
                <HoverCard width={300}>
                  <HoverCard.Target>
                    <ThemeIcon radius="xl" size="xs" color="gray">
                      <IconQuestionMark />
                    </ThemeIcon>
                  </HoverCard.Target>
                  <HoverCard.Dropdown>
                    <Stack spacing={4}>
                      <Text size="md" color="yellow">
                        What&apos;s this?
                      </Text>
                      <Text size="sm">
                        Bounty Files are the files that will be given to the Supporter when they
                        award you the bounty
                      </Text>
                    </Stack>
                  </HoverCard.Dropdown>
                </HoverCard>
              </Group>
            }
            orientation="vertical"
            labelProps={{ size: 'xl', sx: { display: 'inline-flex', gap: 8 } }}
            dropzoneProps={{
              maxFiles: 10,
              accept: acceptedFileTypes,
            }}
            renderItem={(file, onRemove, onUpdate) => {
              const metadata = (file.metadata ?? {}) as BountyEntryFileMeta;
              // const currency = metadata.currency || getBountyCurrency(bounty);
              // const unlockAmount = metadata.unlockAmount || 0;

              return (
                <Paper key={file.id} p={16} radius="md" w="100%" bg="dark.4">
                  <Stack>
                    <Group position="apart">
                      <Stack spacing={0}>
                        {bountyEntry && file.id ? (
                          <Anchor
                            href={`/api/download/attachments/${file.id}`}
                            lineClamp={1}
                            download
                          >
                            {file.name}
                          </Anchor>
                        ) : (
                          <Text size="sm" weight={500} lineClamp={1}>
                            {file.name}
                          </Text>
                        )}
                        <Text color="dimmed" size="xs">
                          {formatKBytes(file.sizeKB)}
                        </Text>
                      </Stack>
                      <Group>
                        {openEntry && (
                          <Tooltip label="Only people who award this entry will have access to this file">
                            <div>
                              <Switch
                                label="Requires contribution"
                                checked={metadata.benefactorsOnly}
                                onChange={(event) =>
                                  onUpdate({
                                    ...file,
                                    metadata: {
                                      ...metadata,
                                      benefactorsOnly: event.currentTarget.checked,
                                    },
                                  })
                                }
                              />
                            </div>
                          </Tooltip>
                        )}
                        <Tooltip label="Remove">
                          <ActionIcon
                            size="md"
                            color="red"
                            variant="light"
                            radius="xl"
                            onClick={onRemove}
                          >
                            <IconTrash size="1rem" />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Group>
                    {/* <NumberInputWrapper
                      label="Unlock amount"
                      description="Only after this amount of awards is reached, the file will be unlocked. For sample files, it's always safest to use 0."
                      icon={<CurrencyIcon currency={currency} size={18} />}
                      format={currency !== Currency.BUZZ ? 'currency' : undefined}
                      currency={currency}
                      value={unlockAmount}
                      max={getMainBountyAmount(bounty)}
                      onChange={(value) => {
                        onUpdate({
                          ...file,
                          metadata: {
                            ...metadata,
                            unlockAmount: value,
                          },
                        });
                      }}
                    /> */}
                  </Stack>
                </Paper>
              );
            }}
            showDropzoneStatus={false}
            withAsterisk
          />
        </Group>
        {openEntry && (
          <NumberInputWrapper
            name="unlockAmount"
            label="Unlock amount"
            description="Set an specific amount people have to award you before they can download your files. This only affects bounty files, sample files are always unlocked."
            labelProps={{ size: 'xl' }}
            icon={<CurrencyIcon currency={currency} size={18} />}
            format={currency !== Currency.BUZZ ? 'currency' : undefined}
            currency={currency}
            min={1}
            max={maxAmount}
          />
        )}
        {/* TODO.bounty: maybe bring this back once we have open entry bounties */}
        {/* <AlertWithIcon icon={<IconInfoCircle />} iconSize="md" mb={0}>
          {openEntry ? (
            <Text>
              In this bounty, any and all users can award you for your entry, even if they are not
              supporters. This means that even after the bounty ends, you can earn rewards. However,
              this also means that after a file is unlocked, even by providing a small amount of
              awards, anyone can download it.
            </Text>
          ) : (
            <Text>
              In this bounty, only people who are marked as supporters can award your entry. Because
              of this, the number of possible awards may be limited. You can set your files to only
              be available to those who give you awards and only unlocked after a certain amount of
              awards is reached.
            </Text>
          )}
        </AlertWithIcon> */}

        <Group mt="xl" position="right">
          <NavigateBack url={`/bounties/${bounty.id}`}>
            {({ onClick }) => (
              <Button variant="light" color="gray" onClick={onClick}>
                Discard Changes
              </Button>
            )}
          </NavigateBack>
          <Button
            loading={bountyEntryCreateMutation.isLoading && !creating}
            disabled={bountyEntryCreateMutation.isLoading}
            onClick={() => setCreating(false)}
            type="submit"
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

type Props = { bountyEntry?: BountyEntryGetById; bounty: BountyGetById };
