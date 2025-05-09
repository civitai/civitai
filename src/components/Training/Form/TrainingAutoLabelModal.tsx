import {
  Button,
  Divider,
  Group,
  Input,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconExclamationMark, IconInfoCircle } from '@tabler/icons-react';
import React, { useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { TrainingImagesLabelTypeSelect } from '~/components/Training/Form/TrainingImagesTagViewer';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { TextInputWrapper } from '~/libs/form/components/TextInputWrapper';
import { UploadType } from '~/server/common/enums';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { useS3UploadStore } from '~/store/s3-upload.store';
import {
  AutoCaptionSchemaType,
  autoLabelLimits,
  AutoTagSchemaType,
  defaultTrainingState,
  defaultTrainingStateVideo,
  getShortNameFromUrl,
  LabelTypes,
  overwriteList,
  trainingStore,
  useTrainingImageStore,
} from '~/store/training.store';
import { getJSZip } from '~/utils/lazy';
import { showErrorNotification } from '~/utils/notifications';
import { titleCase } from '~/utils/string-helpers';

const overwrites: { [key in (typeof overwriteList)[number]]: string } = {
  ignore: 'Skip files with existing labels',
  append: 'Add to the end of existing labels',
  overwrite: 'Overwrite existing labels',
};

const maxImagesCaption = 60;

const useSubmitImages = ({
  modelId,
  mediaType,
  handleClose,
  type,
}: {
  modelId: number;
  mediaType: TrainingDetailsObj['mediaType'];
  handleClose: () => void;
  type: LabelTypes;
}) => {
  const { upload } = useS3UploadStore();
  const [loading, setLoading] = useState(false);
  const { autoTagging, autoCaptioning, imageList } = useTrainingImageStore(
    (state) =>
      state[modelId] ?? {
        ...(mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState),
      }
  );
  const { setAutoLabeling } = trainingStore;

  const filteredImages = imageList.filter((i) =>
    (type === 'caption' ? autoCaptioning : autoTagging).overwrite === 'ignore'
      ? i.label.length === 0
      : i
  );
  const disabled = type === 'caption' && filteredImages.length > maxImagesCaption;

  const handleSubmit = async () => {
    if (disabled) return;

    setLoading(true);

    if (!filteredImages.length) {
      showErrorNotification({
        title: 'No files to process',
        error: new Error(`If you're using "ignore", make sure there are some blank ${type}s.`),
      });
      setLoading(false);
      return;
    }

    const zip = await getJSZip();
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
            setAutoLabeling(modelId, mediaType, {
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

  return { loading, handleSubmit, disabled, numImages: filteredImages.length };
};

const AutoTagSection = ({
  modelId,
  mediaType,
  handleClose,
}: {
  modelId: number;
  mediaType: TrainingDetailsObj['mediaType'];
  handleClose: () => void;
}) => {
  const { autoTagging } = useTrainingImageStore(
    (state) =>
      state[modelId] ?? {
        ...(mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState),
      }
  );
  const { setAutoTagging } = trainingStore;
  const { loading, handleSubmit, numImages } = useSubmitImages({
    modelId,
    mediaType,
    handleClose,
    type: 'tag',
  });

  return (
    <Stack gap="md">
      <Input.Wrapper
        label={
          <Group gap={4} wrap="nowrap">
            <Input.Label>Existing Tags</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              How to handle tags that have already been provided
            </InfoPopover>
          </Group>
        }
        labelProps={{ mb: 'xs' }}
      >
        <SegmentedControl
          value={autoTagging.overwrite}
          data={Object.entries(overwrites).map(([k, v]) => {
            return {
              label: (
                <Tooltip label={v} withinPortal>
                  <Text>{titleCase(k)}</Text>
                </Tooltip>
              ),
              value: k,
            };
          })}
          onChange={(o) =>
            setAutoTagging(modelId, mediaType, { overwrite: o as AutoTagSchemaType['overwrite'] })
          }
          fullWidth
          radius="sm"
        />
      </Input.Wrapper>

      <NumberInputWrapper
        label={
          <Group gap={4} wrap="nowrap">
            <Input.Label>Max Tags</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              Maximum number of tags to add for each file
            </InfoPopover>
          </Group>
        }
        value={autoTagging.maxTags}
        min={autoLabelLimits.tag.tags.min}
        max={autoLabelLimits.tag.tags.max}
        onChange={(value) => {
          setAutoTagging(modelId, mediaType, { maxTags: value });
        }}
      />
      <NumberInputWrapper
        label={
          <Group gap={4} wrap="nowrap">
            <Input.Label>Min Threshold</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              Minimum confidence threshold acceptable for each tag
            </InfoPopover>
          </Group>
        }
        value={autoTagging.threshold}
        min={autoLabelLimits.tag.threshold.min}
        max={autoLabelLimits.tag.threshold.max}
        precision={1}
        step={0.1}
        onChange={(value) => {
          setAutoTagging(modelId, mediaType, { threshold: value });
        }}
      />

      <TextInputWrapper
        value={autoTagging.blacklist}
        onChange={(event) => {
          setAutoTagging(modelId, mediaType, { blacklist: event.currentTarget.value });
        }}
        label={
          <Group gap={4} wrap="nowrap">
            <Input.Label>Blacklist</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              Comma-separated list of tags to exclude from results
            </InfoPopover>
          </Group>
        }
        placeholder="bad_tag_1, bad_tag_2"
      />
      <TextInputWrapper
        value={autoTagging.prependTags}
        onChange={(event) => {
          setAutoTagging(modelId, mediaType, { prependTags: event.currentTarget.value });
        }}
        label={
          <Group gap={4} wrap="nowrap">
            <Input.Label>Prepend Tags</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              Comma-separated list of tags to prepend to all results
            </InfoPopover>
          </Group>
        }
        placeholder="important, details"
      />
      <TextInputWrapper
        value={autoTagging.appendTags}
        onChange={(event) => {
          setAutoTagging(modelId, mediaType, { appendTags: event.currentTarget.value });
        }}
        label={
          <Group gap={4} wrap="nowrap">
            <Input.Label>Append Tags</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              Comma-separated list of tags to append to all results
            </InfoPopover>
          </Group>
        }
        placeholder="minor, details"
      />

      <Group justify="flex-end" mt="xl">
        <Button variant="light" color="gray" onClick={handleClose}>
          Cancel
        </Button>
        <Button loading={loading} onClick={handleSubmit}>
          {loading ? 'Sending data...' : `Submit (${numImages})`}
        </Button>
      </Group>
    </Stack>
  );
};

const AutoCaptionSection = ({
  modelId,
  mediaType,
  handleClose,
}: {
  modelId: number;
  mediaType: TrainingDetailsObj['mediaType'];
  handleClose: () => void;
}) => {
  const { autoCaptioning } = useTrainingImageStore(
    (state) =>
      state[modelId] ?? {
        ...(mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState),
      }
  );
  const { setAutoCaptioning } = trainingStore;
  const { loading, handleSubmit, numImages, disabled } = useSubmitImages({
    modelId,
    mediaType,
    handleClose,
    type: 'caption',
  });

  return (
    <Stack gap="md">
      {!disabled ? (
        <AlertWithIcon
          title="Long run times"
          icon={<IconInfoCircle />}
          py={5}
          my="xs"
          iconSize="lg"
          radius="md"
        >
          <Text>
            Natural language captioning can take a long time to run. Please remain on this page
            while it is in progress.
          </Text>
        </AlertWithIcon>
      ) : (
        <AlertWithIcon
          title="Too many files"
          icon={<IconExclamationMark />}
          py={5}
          my="xs"
          iconSize="lg"
          radius="md"
          color="red"
          iconColor="red"
        >
          <Text>
            {`A maximum of ${maxImagesCaption} files at a time may be sent for captioning (you have ${numImages}).`}
          </Text>
        </AlertWithIcon>
      )}
      <Input.Wrapper
        label={
          <Group gap={4} wrap="nowrap">
            <Input.Label>Existing Captions</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              How to handle captions that have already been provided
            </InfoPopover>
          </Group>
        }
        labelProps={{ mb: 'xs' }}
      >
        <SegmentedControl
          value={autoCaptioning.overwrite}
          data={Object.entries(overwrites).map(([k, v]) => {
            return {
              label: (
                <Tooltip label={v} withinPortal>
                  <Text>{titleCase(k)}</Text>
                </Tooltip>
              ),
              value: k,
            };
          })}
          onChange={(o) =>
            setAutoCaptioning(modelId, mediaType, {
              overwrite: o as AutoCaptionSchemaType['overwrite'],
            })
          }
          fullWidth
          radius="sm"
          disabled={disabled}
        />
      </Input.Wrapper>

      <NumberInputWrapper
        label={
          <Group gap={4} wrap="nowrap">
            <Input.Label>Temperature</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              Higher temperatures encourage diverse and creative responses. Lower temperatures
              produce more predictable descriptions.
            </InfoPopover>
          </Group>
        }
        value={autoCaptioning.temperature}
        min={autoLabelLimits.caption.temperature.min}
        max={autoLabelLimits.caption.temperature.max}
        precision={2}
        step={0.01}
        onChange={(value) => {
          setAutoCaptioning(modelId, mediaType, { temperature: value });
        }}
        disabled={disabled}
      />
      <NumberInputWrapper
        label={
          <Group gap={4} wrap="nowrap">
            <Input.Label>Max New Tokens</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              Gives guidance for how long descriptions will be. Tokens are approximately 3/4 a word
              on average. This may not always be respected, so consider this a guideline.
            </InfoPopover>
          </Group>
        }
        value={autoCaptioning.maxNewTokens}
        min={autoLabelLimits.caption.maxNewTokens.min}
        max={autoLabelLimits.caption.maxNewTokens.max}
        onChange={(value) => {
          setAutoCaptioning(modelId, mediaType, { maxNewTokens: value });
        }}
        disabled={disabled}
      />

      <Group justify="flex-end" mt="xl">
        <Button variant="light" color="gray" onClick={handleClose}>
          Cancel
        </Button>
        <Button loading={loading} onClick={handleSubmit} disabled={disabled}>
          {loading ? 'Sending data...' : `Submit (${numImages})`}
        </Button>
      </Group>
    </Stack>
  );
};

export const AutoLabelModal = ({
  modelId,
  mediaType,
}: {
  modelId: number;
  mediaType: TrainingDetailsObj['mediaType'];
}) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { labelType } = useTrainingImageStore(
    (state) =>
      state[modelId] ?? {
        ...(mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState),
      }
  );

  return (
    <Modal {...dialog} centered size="md" radius="md" title="Automatically label your files">
      <Stack>
        <Text>Label Type</Text>
        <TrainingImagesLabelTypeSelect modelId={modelId} mediaType={mediaType} />
        <Divider />
        {labelType === 'caption' ? (
          <AutoCaptionSection modelId={modelId} mediaType={mediaType} handleClose={handleClose} />
        ) : (
          <AutoTagSection modelId={modelId} mediaType={mediaType} handleClose={handleClose} />
        )}
      </Stack>
    </Modal>
  );
};
