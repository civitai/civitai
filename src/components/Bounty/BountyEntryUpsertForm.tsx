import {
  ActionIcon,
  Anchor,
  Button,
  Checkbox,
  Divider,
  Group,
  HoverCard,
  Input,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { BountyEntryMode, BountyType, Currency } from '@prisma/client';
import { IconInfoCircle, IconQuestionMark, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { z } from 'zod';

import { BackButton, NavigateBack } from '~/components/BackButton/BackButton';
import { getBountyCurrency, getMainBountyAmount } from '~/components/Bounty/bounty.utils';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { Form, InputCheckbox, InputMultiFileUpload, InputRTE, useForm } from '~/libs/form';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE, ZIP_MIME_TYPE } from '~/server/common/mime-types';
import {
  BountyEntryFileMeta,
  bountyEntryFileSchema,
  upsertBountyEntryInputSchema,
} from '~/server/schema/bounty-entry.schema';
import { BountyEntryGetById, BountyGetById } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { formatKBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { PoiAlert } from '~/components/PoiAlert/PoiAlert';
import { getFilesHash } from '~/client-utils/file-hashing';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { FeatureIntroductionHelpButton } from '../FeatureIntroduction/FeatureIntroduction';
// import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';

const dropzoneOptionsByModelType: Record<BountyType, string[] | Record<string, string[]>> = {
  ModelCreation: {
    'application/octet-stream': ['.ckpt', '.pt', '.safetensors', '.sft', '.bin', '.onnx'],
    'application/zip': ['.zip'],
    'application/x-yaml': ['.yaml', '.yml'],
  },
  LoraCreation: {
    'application/octet-stream': ['.ckpt', '.pt', '.safetensors', '.sft', '.bin'],
    'application/zip': ['.zip'],
    'application/x-yaml': ['.yaml', '.yml'],
  },
  EmbedCreation: {
    'application/octet-stream': ['.ckpt', '.pt', '.safetensors', '.sft', '.bin'],
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
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { files: imageFiles, uploadToCF, removeImage } = useCFImageUpload();
  const queryUtils = trpc.useUtils();
  const [bountyEntryImages, setBountyEntryImages] = useState<BountyEntryGetById['images']>(
    bountyEntry?.images ?? []
  );
  const [ownershipAcknowledgement, setOwnershipAcknowledgement] = useState(false);

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

  const bountyFiles = form.watch('bountyFiles');

  const [creating, setCreating] = useState(false);
  const bountyEntryUpsertMutation = trpc.bountyEntry.upsert.useMutation();
  const { mutateAsync: getModelsByHashMutation } = trpc.model.getModelsByHash.useMutation();

  const handleSubmit = ({
    bountyFiles,
    sampleFiles = [],
    unlockAmount,
    ...data
  }: z.infer<typeof formSchema>) => {
    const filteredImages = imageFiles.filter((file) => file.status === 'success');

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

    bountyEntryUpsertMutation.mutate(
      { ...data, bountyId: bounty.id, images: [...bountyEntryImages, ...filteredImages], files },
      {
        async onSuccess() {
          await queryUtils.bounty.getEntries.invalidate({ id: bounty.id });
          await router.push(`/bounties/${bounty.id}`);
        },
        onError(error) {
          try {
            // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
            const parsedError = JSON.parse(error.message);
            showErrorNotification({
              title: 'Failed to create or update bounty entry',
              error: parsedError,
            });
          } catch (e) {
            // Report old error as is:
            showErrorNotification({
              title: 'Failed to create or update bounty entry',
              error: new Error(error.message),
            });
          }
        },
      }
    );
  };

  const acceptedFileTypes =
    dropzoneOptionsByModelType[bounty.type] ?? dropzoneOptionsByModelType.Other;
  const images = [...bountyEntryImages, ...imageFiles];

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing="xl">
        <Group spacing="md">
          <BackButton url={`/bounties/${bounty.id}`} />
          <Title inline>{bountyEntry ? 'Update' : 'Submit new'} entry</Title>
          <FeatureIntroductionHelpButton
            feature="bounty-submit-entry"
            contentSlug={['feature-introduction', 'bounty-submit-entry']}
          />
        </Group>
        {bounty.poi && <PoiAlert size="sm" />}
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
        {images.length > 0 && (
          <SimpleGrid
            spacing="sm"
            breakpoints={[
              { minWidth: 'xs', cols: 1 },
              { minWidth: 'sm', cols: 3 },
              { minWidth: 'md', cols: 4 },
            ]}
          >
            {bountyEntryImages.map((image) => (
              <Paper
                key={image.id}
                radius="sm"
                p={0}
                sx={{ position: 'relative', overflow: 'hidden', height: 332 }}
                withBorder
              >
                <EdgeMedia
                  placeholder="empty"
                  src={image.url}
                  alt={undefined}
                  style={{ objectFit: 'cover', height: '100%' }}
                />
                <div style={{ position: 'absolute', top: 12, right: 12 }}>
                  <ActionIcon
                    variant="filled"
                    size="lg"
                    color="red"
                    onClick={() => {
                      setBountyEntryImages((current) => {
                        return current.filter((i) => i.id !== image.id);
                      });
                    }}
                  >
                    <IconTrash size={26} strokeWidth={2.5} />
                  </ActionIcon>
                </div>
                {image.meta && (
                  <div style={{ position: 'absolute', bottom: 12, right: 12 }}>
                    <ImageMetaPopover meta={image.meta}>
                      <ActionIcon variant="light" color="dark" size="lg">
                        <IconInfoCircle color="white" strokeWidth={2.5} size={26} />
                      </ActionIcon>
                    </ImageMetaPopover>
                  </div>
                )}
              </Paper>
            ))}
            {imageFiles
              .slice()
              .reverse()
              .map((file) => (
                <Paper
                  key={file.url}
                  radius="sm"
                  p={0}
                  sx={{ position: 'relative', overflow: 'hidden', height: 332 }}
                  withBorder
                >
                  {file.status === 'success' ? (
                    <>
                      <EdgeMedia
                        placeholder="empty"
                        src={file.url}
                        alt={file.name ?? undefined}
                        style={{ objectFit: 'cover', height: '100%' }}
                      />
                      <div style={{ position: 'absolute', top: 12, right: 12 }}>
                        <ActionIcon
                          variant="filled"
                          size="lg"
                          color="red"
                          onClick={() => removeImage(file.url)}
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
                    <Group position="apart" noWrap>
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
            onFilesValidate={async (files) => {
              if (
                ![BountyType.ModelCreation, BountyType.LoraCreation, BountyType.EmbedCreation].some(
                  (t) => t === bounty.type
                )
              ) {
                // Anything goes:
                return {
                  valid: true,
                };
              }

              const hashes = await getFilesHash(files);
              const existingModels = await getModelsByHashMutation({
                hashes,
              });

              if (
                existingModels.length > 0 &&
                existingModels.find((m) => m.userId !== currentUser?.id)
              ) {
                return {
                  valid: false,
                  errors: [
                    'You cannot submit a model that already exists in the system and does not belong to your account',
                  ],
                };
              }

              return {
                valid: true,
              };
            }}
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
                    <Group position="apart" noWrap>
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
        {!bountyEntry && bountyFiles && bountyFiles.length > 0 && (
          <InputCheckbox name="ownRights" label="I own the rights to these files" mt="xs" />
        )}
        {openEntry && (
          <NumberInputWrapper
            name="unlockAmount"
            label="Unlock amount"
            description="Set a specific amount people have to award you before they can download your files. This only affects bounty files - sample files are always unlocked."
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
        {!bountyEntry && (
          <>
            <Divider />
            <Checkbox
              checked={ownershipAcknowledgement}
              onChange={(event) => setOwnershipAcknowledgement(event.currentTarget.checked)}
              label="By submitting an entry you consent that in the event that you win the bounty, the creator of the bounty has ownership over your entry, and can do with it what they will."
            />
          </>
        )}
        <Group mt="xl" position="right">
          <NavigateBack url={`/bounties/${bounty.id}`}>
            {({ onClick }) => (
              <Button variant="light" color="gray" onClick={onClick}>
                Discard Changes
              </Button>
            )}
          </NavigateBack>

          <Button
            loading={bountyEntryUpsertMutation.isLoading && !creating}
            disabled={
              bountyEntryUpsertMutation.isLoading || (!bountyEntry && !ownershipAcknowledgement)
            }
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
