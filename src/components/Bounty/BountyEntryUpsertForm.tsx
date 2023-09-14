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
  Divider,
  Anchor,
  Tooltip,
  Switch,
} from '@mantine/core';
import { IconInfoCircle, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useState } from 'react';

import { BackButton } from '~/components/BackButton/BackButton';
import { Form, InputMultiFileUpload, useForm } from '~/libs/form';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/server/common/mime-types';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { TRPCClientError } from '@trpc/client';
import { z } from 'zod';
import { BountyEntryGetById, BountyGetById } from '~/types/router';
import {
  BountyEntryFileMeta,
  upsertBountyEntryInputSchema,
} from '~/server/schema/bounty-entry.schema';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { getBountyCurrency, getMainBountyAmount } from '~/components/Bounty/bounty.utils';
import { BountyEntryMode, Currency } from '@prisma/client';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { formatKBytes } from '~/utils/number-helpers';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';

const formSchema = upsertBountyEntryInputSchema.omit({
  images: true,
  bountyId: true,
});

export function BountyEntryUpsertForm({ bountyEntry, bounty }: Props) {
  const router = useRouter();
  const { files: imageFiles, uploadToCF, removeImage } = useCFImageUpload();
  const queryUtils = trpc.useContext();

  const handleDropImages = async (droppedFiles: File[]) => {
    for (const file of droppedFiles) {
      uploadToCF(file);
    }
  };

  const form = useForm({
    schema: formSchema,
    defaultValues: {
      files: (bountyEntry?.files ?? []).map((f) => ({ ...f, url: f.url || '' })),
    },
    shouldUnregister: false,
  });

  const [creating, setCreating] = useState(false);
  const bountyEntryCreateMutation = trpc.bountyEntry.create.useMutation();

  const handleSubmit = ({ ...data }: z.infer<typeof formSchema>) => {
    const filteredImages = imageFiles
      .filter((file) => file.status === 'success')
      .map(({ id, url, ...file }) => ({ ...file, url: id })); ///

    bountyEntryCreateMutation.mutate(
      { ...data, bountyId: bounty.id, images: filteredImages },
      {
        async onSuccess() {
          await queryUtils.bounty.getEntries.invalidate({ id: bounty.id });
          await router.push(`/bounties/${bounty.id}`);
        },
        onError(error) {
          if (error instanceof TRPCClientError) {
            const parsedError = JSON.parse(error.message);
            showErrorNotification({
              title: 'Failed to create bounty',
              error: new Error(
                Array.isArray(parsedError) ? parsedError[0].message : parsedError.message
              ),
            });
          } else {
            showErrorNotification({
              title: 'Failed to create bounty',
              error: new Error(error.message),
            });
          }
        },
      }
    );
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing="xl">
        <Group spacing={4}>
          <BackButton url={`/bounties/${bounty.id}`} />
          <Title>Submit new entry</Title>
        </Group>
        <Divider label="Bounty Images" />
        <Text>
          Please add at least 1 image to your bounty entry. This will serve as a reference point for
          Hunters and will also be used as your cover image.
        </Text>
        <ImageDropzone
          label="Drag & drop images here or click to browse"
          onDrop={handleDropImages}
          count={imageFiles.length}
          accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
        />
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
        <AlertWithIcon icon={<IconInfoCircle />} iconSize="md" mb={0}>
          {bounty.entryMode === BountyEntryMode.Open && (
            <Text>
              In this bounty, any and all users can award you for your entry, even if they are not
              supporters. This means that even after the bounty ends, you can earn rewards. However,
              this also means that after a file is unlocked, even by providing a small amount of
              awards, anyone can download it.
            </Text>
          )}
          {bounty.entryMode === BountyEntryMode.BenefactorsOnly && (
            <Text>
              In this bounty, only people who are marked as supporters can award your entry. Because
              of this, the number of possible awards may be limited. You can set your files to only
              be available to those who give you awards and only unlocked after a certain amount of
              awards is reached.
            </Text>
          )}
        </AlertWithIcon>
        <InputMultiFileUpload
          name="files"
          label="Files"
          dropzoneProps={{
            maxSize: 100 * 1024 ** 2, // 100MB
            maxFiles: 10,
            accept: {
              'application/pdf': ['.pdf'],
              'application/zip': ['.zip'],
              'application/json': ['.json'],
              'application/x-yaml': ['.yaml', '.yml'],
              'text/plain': ['.txt'],
              'text/markdown': ['.md'],
              'text/x-python-script': ['.py'],
            },
          }}
          renderItem={(file, onRemove, onUpdate) => {
            const metadata = (file.metadata ?? {}) as BountyEntryFileMeta;
            const currency = metadata.currency || getBountyCurrency(bounty);
            const unlockAmount = metadata.unlockAmount || 0;

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
                  <NumberInputWrapper
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
                  />
                </Stack>
              </Paper>
            );
          }}
        />

        <Group mt="xl" position="right">
          <Button
            loading={bountyEntryCreateMutation.isLoading && !creating}
            disabled={bountyEntryCreateMutation.isLoading}
            onClick={() => setCreating(false)}
            type="submit"
            fullWidth
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

type Props = { bountyEntry?: BountyEntryGetById; bounty: BountyGetById };
