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
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { TextInputWrapper } from '~/libs/form/components/TextInputWrapper';
import { UploadType } from '~/server/common/enums';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { useS3UploadStore } from '~/store/s3-upload.store';
import type {
  AutoCaptionSchemaType,
  AutoTagSchemaType,
  LabelTypes,
  overwriteList,
} from '~/store/training.store';
import {
  autoLabelLimits,
  defaultTrainingState,
  defaultTrainingStateVideo,
  getShortNameFromUrl,
  trainingStore,
  useTrainingImageStore,
} from '~/store/training.store';
import { getJSZip } from '~/utils/lazy';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { titleCase } from '~/utils/string-helpers';
import { uploadAndSubmitAutoLabel } from '~/utils/training/auto-label-orchestrator';

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
  const features = useFeatureFlags();
  const { upload } = useS3UploadStore();
  const [loading, setLoading] = useState(false);
  const { autoTagging, autoCaptioning, imageList } = useTrainingImageStore(
    (state) =>
      state[modelId] ?? {
        ...(mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState),
      }
  );
  const { setAutoLabeling, updateImage } = trainingStore;

  const filteredImages = imageList.filter((i) =>
    (type === 'caption' ? autoCaptioning : autoTagging).overwrite === 'ignore'
      ? i.label.length === 0
      : i
  );
  const disabled = type === 'caption' && filteredImages.length > maxImagesCaption;

  const submitViaOrchestrator = async () => {
    // Materialize blobs from the same source URLs the legacy zip path used.
    // Without the .ok check, a 403/404 HTML body would be uploaded as the "image".
    const images = await Promise.all(
      filteredImages.map(async (imgData) => {
        const res = await fetch(imgData.url);
        if (!res.ok) {
          throw new Error(
            `Failed to fetch ${getShortNameFromUrl(imgData)} (${res.status} ${res.statusText})`
          );
        }
        return { filename: getShortNameFromUrl(imgData), blob: await res.blob() };
      })
    );

    setAutoLabeling(modelId, mediaType, {
      url: null,
      isRunning: true,
      total: images.length,
      successes: 0,
      fails: [],
    });

    const overwriteMode = (type === 'caption' ? autoCaptioning : autoTagging).overwrite;

    const onResult = (filename: string, label: string) => {
      updateImage(modelId, mediaType, {
        matcher: filename,
        label,
        appendLabel: overwriteMode === 'append',
      });
      const current = useTrainingImageStore.getState()[modelId]?.autoLabeling;
      if (current) {
        setAutoLabeling(modelId, mediaType, {
          ...current,
          successes: current.successes + 1,
        });
      }
    };
    const onFailure = (filename: string) => {
      if (!filename) return;
      const current = useTrainingImageStore.getState()[modelId]?.autoLabeling;
      if (current) {
        setAutoLabeling(modelId, mediaType, {
          ...current,
          fails: [...current.fails, filename],
        });
      }
    };
    const onDone = ({ successes, fails }: { successes: number; fails: string[] }) => {
      const labelNoun = type === 'caption' ? 'caption' : 'tag';
      const labelVerb = type === 'caption' ? 'Captioned' : 'Tagged';
      const message = `${labelVerb} ${successes} image${successes === 1 ? '' : 's'}.${
        fails.length > 0 ? ` Failures: ${fails.length}` : ''
      }`;
      if (successes === 0) {
        showErrorNotification({
          title: `Auto-${labelNoun} failed`,
          error: new Error(message),
        });
      } else if (fails.length > 0) {
        showErrorNotification({
          title: `Auto-${labelNoun} finished with errors`,
          error: new Error(message),
        });
      } else {
        showSuccessNotification({
          title: 'Images auto-labeled successfully!',
          message,
        });
      }
      const defaultState =
        mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState;
      setAutoLabeling(modelId, mediaType, { ...defaultState.autoLabeling });
    };

    const postProcess = {
      blacklist: type === 'tag' ? autoTagging.blacklist : '',
      prependTags: type === 'tag' ? autoTagging.prependTags : '',
      appendTags: type === 'tag' ? autoTagging.appendTags : '',
      maxTags: type === 'tag' ? autoTagging.maxTags : undefined,
      threshold: type === 'tag' ? autoTagging.threshold : undefined,
      overwrite: overwriteMode,
    };

    // Polling continues after the modal closes — bail out cleanly if the user
    // resets the run from elsewhere (re-opens the modal, navigates away, etc.).
    const isActive = () =>
      useTrainingImageStore.getState()[modelId]?.autoLabeling.isRunning ?? false;

    try {
      if (type === 'tag') {
        await uploadAndSubmitAutoLabel({
          modelId,
          mediaType: mediaType ?? 'image',
          type: 'tag',
          images,
          params: { threshold: autoTagging.threshold },
          postProcess,
          isActive,
          onResult,
          onFailure,
          onDone,
        });
      } else {
        await uploadAndSubmitAutoLabel({
          modelId,
          mediaType: mediaType ?? 'image',
          type: 'caption',
          images,
          params: {
            temperature: autoCaptioning.temperature,
            maxNewTokens: autoCaptioning.maxNewTokens,
          },
          postProcess,
          isActive,
          onResult,
          onFailure,
          onDone,
        });
      }
    } catch (e) {
      const defaultState =
        mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState;
      setAutoLabeling(modelId, mediaType, { ...defaultState.autoLabeling });
      throw e;
    }
  };

  const submitViaLegacyZip = async () => {
    const zip = await getJSZip();
    await Promise.all(
      filteredImages.map(async (imgData) => {
        const imgBlob = await fetch(imgData.url).then((res) => res.blob());
        zip.file(getShortNameFromUrl(imgData), imgBlob);
      })
    );

    const content = await zip.generateAsync({ type: 'blob' });
    const blobFile = new File([content], `${modelId}_temp_tagging_data.zip`, {
      type: 'application/zip',
    });

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
      }
    );
  };

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

    try {
      // The orchestrator flag overrides — when on, we always use the new flow,
      // regardless of what trainingAutoTag / trainingAutoCaption say.
      if (features.trainingAutoLabelOrchestrator) {
        await submitViaOrchestrator();
      } else {
        await submitViaLegacyZip();
      }
      handleClose();
    } catch (e) {
      showErrorNotification({
        error: e instanceof Error ? e : new Error('Please try again'),
        title: 'Failed to send data',
        autoClose: false,
      });
    } finally {
      setLoading(false);
    }
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
  const features = useFeatureFlags();
  // Orchestrator path doesn't need the legacy service-availability flag, so the new
  // flag overrides it. Otherwise fall back to the existing trainingAutoTag check.
  const available = features.trainingAutoLabelOrchestrator || features.trainingAutoTag;
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
      {!available && (
        <AlertWithIcon
          title="Auto-tagging unavailable"
          icon={<IconExclamationMark />}
          py={5}
          my="xs"
          iconSize="lg"
          radius="md"
          color="red"
          iconColor="red"
        >
          <Text>
            Auto-tagging is temporarily unavailable. We&apos;re actively looking into it - please
            check back soon.
          </Text>
        </AlertWithIcon>
      )}
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
          setAutoTagging(modelId, mediaType, { maxTags: Number(value) });
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
        decimalScale={1}
        step={0.1}
        onChange={(value) => {
          setAutoTagging(modelId, mediaType, { threshold: Number(value) });
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
        <Button loading={loading} onClick={handleSubmit} disabled={!available}>
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
  const features = useFeatureFlags();
  // Orchestrator path doesn't need the legacy service-availability flag, so the new
  // flag overrides it. Otherwise fall back to the existing trainingAutoCaption check.
  const available = features.trainingAutoLabelOrchestrator || features.trainingAutoCaption;
  const { autoCaptioning } = useTrainingImageStore(
    (state) =>
      state[modelId] ?? {
        ...(mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState),
      }
  );
  const { setAutoCaptioning } = trainingStore;
  const { loading, handleSubmit, numImages, disabled: limitReached } = useSubmitImages({
    modelId,
    mediaType,
    handleClose,
    type: 'caption',
  });
  const disabled = limitReached || !available;

  return (
    <Stack gap="md">
      {!available && (
        <AlertWithIcon
          title="Auto-captioning unavailable"
          icon={<IconExclamationMark />}
          py={5}
          my="xs"
          iconSize="lg"
          radius="md"
          color="red"
          iconColor="red"
        >
          <Text>
            Auto-captioning is temporarily unavailable. We&apos;re actively looking into it -
            please check back soon.
          </Text>
        </AlertWithIcon>
      )}
      {available &&
        (!limitReached ? (
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
        ))}
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
        decimalScale={2}
        step={0.01}
        onChange={(value) => {
          setAutoCaptioning(modelId, mediaType, { temperature: Number(value) });
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
          setAutoCaptioning(modelId, mediaType, { maxNewTokens: Number(value) });
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
