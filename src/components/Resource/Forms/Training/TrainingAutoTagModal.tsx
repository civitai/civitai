import { Button, Group, Input, Modal, Stack, Text, Tooltip } from '@mantine/core';
import JSZip from 'jszip';
import React, { useState } from 'react';
import { z } from 'zod';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { Form, InputNumberSlider, InputSegmentedControl, InputText, useForm } from '~/libs/form';
import { UploadType } from '~/server/common/enums';
import { useS3UploadStore } from '~/store/s3-upload.store';
import {
  type AutoCaptionType,
  getShortNameFromUrl,
  type ImageDataType,
} from '~/store/training.store';
import { showErrorNotification } from '~/utils/notifications';
import { titleCase } from '~/utils/string-helpers';

const MIN_TAGS = 1;
export const MAX_TAGS = 30;
export const MIN_THRESHOLD = 0.3;
const MAX_THRESHOLD = 0.9;

const OVERWRITE_LIST = ['ignore', 'append', 'overwrite'] as const;
const OVERWRITES: Record<(typeof OVERWRITE_LIST)[number], string> = {
  ignore: 'Skip images with existing captions',
  append: 'Add tags to existing captions',
  overwrite: 'Overwrite existing captions',
} as const;

const schema = z.object({
  maxTags: z.number().int().min(MIN_TAGS).max(MAX_TAGS),
  threshold: z.number().min(MIN_THRESHOLD).max(MAX_THRESHOLD),
  overwrite: z.enum(OVERWRITE_LIST),
  blacklist: z.string(),
  prependTags: z.string(),
  appendTags: z.string(),
});
export type AutoTagSchemaType = z.infer<typeof schema>;

const defaults: AutoTagSchemaType = {
  maxTags: 10,
  threshold: 0.4,
  overwrite: 'ignore' as AutoTagSchemaType['overwrite'],
  blacklist: '',
  prependTags: '',
  appendTags: '',
};

export const AutoTagModal = ({
  imageList,
  modelId,
  setAutoCaptioning,
}: {
  imageList: ImageDataType[];
  modelId: number;
  setAutoCaptioning: (modelId: number, data: AutoCaptionType) => void;
}) => {
  const dialog = useDialogContext();
  const form = useForm({ schema, defaultValues: defaults });
  const { upload } = useS3UploadStore();
  const [loading, setLoading] = useState(false);

  const handleClose = dialog.onClose;

  const handleSubmit = async (data: AutoTagSchemaType) => {
    setLoading(true);
    const { maxTags, threshold, overwrite, blacklist, prependTags, appendTags } = data;

    const filteredImages = imageList.filter((i) =>
      overwrite === 'ignore' ? i.caption.length === 0 : i
    );

    if (!filteredImages.length) {
      showErrorNotification({
        title: 'No images to process',
        error: new Error('If you\'re using "ignore", make sure there are some blank captions.'),
      });
      setLoading(false);
      return;
    }

    const zip = new JSZip();

    await Promise.all(
      filteredImages.map(async (imgData) => {
        const imgBlob = await fetch(imgData.url).then((res) => res.blob());
        zip.file(getShortNameFromUrl(imgData), imgBlob);
      })
    );

    zip.generateAsync({ type: 'blob' }).then(async (content) => {
      const blobFile = new File([content], `${modelId}_temp_tagging_data.zip`, {
        type: 'application/zip',
      });

      try {
        await upload(
          {
            file: blobFile,
            type: UploadType.TrainingImagesTemp,
            meta: {},
          },
          async ({ url }) => {
            setAutoCaptioning(modelId, {
              maxTags,
              threshold,
              overwrite,
              blacklist,
              prependTags,
              appendTags,
              url,
              isRunning: false,
              total: filteredImages.length,
              successes: 0,
              fails: [],
            });
            handleClose();
            setLoading(false);
          }
        );
      } catch (e) {
        showErrorNotification({
          error: e instanceof Error ? e : new Error('Please try again'),
          title: 'Failed to send data',
          autoClose: false,
        });
        setLoading(false);
      }
    });
  };

  return (
    <Modal {...dialog} centered size="md" radius="md" title="Automatically caption your images">
      <Form form={form} onSubmit={handleSubmit}>
        <Stack spacing="md">
          <InputNumberSlider
            name="maxTags"
            label={
              <Group spacing={4} noWrap>
                <Input.Label>Max Tags</Input.Label>
                <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
                  Maximum number of tags to add for each image
                </InfoPopover>
              </Group>
            }
            min={MIN_TAGS}
            max={MAX_TAGS}
          />
          <InputNumberSlider
            name="threshold"
            label={
              <Group spacing={4} noWrap>
                <Input.Label>Min Threshold</Input.Label>
                <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
                  Minimum confidence threshold acceptable for each tag
                </InfoPopover>
              </Group>
            }
            min={MIN_THRESHOLD}
            max={MAX_THRESHOLD}
            step={0.1}
          />
          <Input.Wrapper
            label={
              <Group spacing={4} noWrap>
                <Input.Label>Existing Captions</Input.Label>
                <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
                  How to handle captions that have already been provided
                </InfoPopover>
              </Group>
            }
            labelProps={{ mb: 'xs' }}
          >
            <InputSegmentedControl
              name="overwrite"
              radius="sm"
              data={Object.entries(OVERWRITES).map(([k, v]) => {
                return {
                  label: (
                    <Tooltip label={v} withinPortal>
                      <Text>{titleCase(k)}</Text>
                    </Tooltip>
                  ),
                  value: k,
                };
              })}
              fullWidth
            />
          </Input.Wrapper>
          <InputText
            name="blacklist"
            label={
              <Group spacing={4} noWrap>
                <Input.Label>Blacklist</Input.Label>
                <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
                  Comma-separated list of tags to exclude from results
                </InfoPopover>
              </Group>
            }
            placeholder="bad_tag_1, bad_tag_2"
          />
          <InputText
            name="prependTags"
            label={
              <Group spacing={4} noWrap>
                <Input.Label>Prepend Tags</Input.Label>
                <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
                  Comma-separated list of tags to prepend to all results
                </InfoPopover>
              </Group>
            }
            placeholder="important, details"
          />
          <InputText
            name="appendTags"
            label={
              <Group spacing={4} noWrap>
                <Input.Label>Append Tags</Input.Label>
                <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
                  Comma-separated list of tags to append to all results
                </InfoPopover>
              </Group>
            }
            placeholder="minor, details"
          />
          <Group position="right" mt="xl">
            <Button variant="light" color="gray" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" loading={loading}>
              {loading ? 'Sending data...' : 'Submit'}
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
};
