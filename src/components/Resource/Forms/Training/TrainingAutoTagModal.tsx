import { Button, Group, Input, Stack, Text, Tooltip } from '@mantine/core';
import JSZip from 'jszip';
import React, { useState } from 'react';
import { z } from 'zod';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import {
  AutoCaptionType,
  ImageDataType,
} from '~/components/Resource/Forms/Training/TrainingImages';
import { Form, InputNumberSlider, InputSegmentedControl, useForm } from '~/libs/form';
import { UploadType } from '~/server/common/enums';
import { useS3UploadStore } from '~/store/s3-upload.store';
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
});
export type AutoTagSchemaType = z.infer<typeof schema>;

const defaults = {
  maxTags: 10,
  threshold: 0.4,
  overwrite: 'ignore' as AutoTagSchemaType['overwrite'],
};

const { openModal, Modal } = createContextModal<{
  imageList: ImageDataType[];
  modelId: number;
  setAutoCaptioning: (modelId: number, data: AutoCaptionType) => void;
}>({
  title: 'Automatically caption your images',
  name: 'autoTag',
  centered: true,
  radius: 'lg',
  Element: ({ context, props: { imageList, modelId, setAutoCaptioning } }) => {
    const [loading, setLoading] = useState(false);
    const form = useForm({ schema, defaultValues: defaults });
    const { upload } = useS3UploadStore();

    const handleClose = () => context.close();

    const handleSubmit = async (data: AutoTagSchemaType) => {
      setLoading(true);
      const { maxTags, threshold, overwrite } = data;

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
          zip.file(imgData.name, imgBlob);
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
            async ({ url, ...other }) => {
              setAutoCaptioning(modelId, { maxTags, threshold, overwrite, url, isRunning: false });
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
    );
  },
});

export const openAutoTagModal = openModal;
export default Modal;
