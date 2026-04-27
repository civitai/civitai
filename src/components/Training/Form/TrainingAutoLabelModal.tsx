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
import {
  type AutoLabelHandle,
  uploadAndSubmitAutoLabel,
} from '~/utils/training/auto-label-orchestrator';

const overwrites: { [key in (typeof overwriteList)[number]]: string } = {
  ignore: 'Skip files with existing labels',
  append: 'Add to the end of existing labels',
  overwrite: 'Overwrite existing labels',
};

// Legacy zip path bottlenecks past ~60 captioned files; the orchestrator path
// chunks into batched workflows so the cap doesn't apply there.
const maxImagesCaption = 60;
// Browsers throttle concurrent fetches to one origin, but kicking off 500+
// unbounded promises ties up memory holding all those blobs at once.
const SOURCE_FETCH_CONCURRENCY = 6;

// Track the in-flight orchestrator handle per model so a fresh submit can
// cancel any prior run before it scribbles into the new run's labels.
const inFlightHandles = new Map<number, AutoLabelHandle>();

async function fetchWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await task(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

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
  const { setAutoLabeling, mutateAutoLabeling, updateImage } = trainingStore;

  const filteredImages = imageList.filter((i) =>
    (type === 'caption' ? autoCaptioning : autoTagging).overwrite === 'ignore'
      ? i.label.length === 0
      : i
  );
  // Caption cap only applies on the legacy path — orchestrator handles arbitrary counts.
  const disabled =
    type === 'caption' &&
    filteredImages.length > maxImagesCaption &&
    !features.trainingAutoLabelOrchestrator;

  const submitViaOrchestrator = async () => {
    // Cancel any prior run for this model — without this, an old poll loop
    // from a previous submit will keep firing onResult against the new run's
    // store state and corrupt the new labels.
    inFlightHandles.get(modelId)?.cancel();
    inFlightHandles.delete(modelId);

    // Stamp this run with a unique id so background callbacks from the prior
    // run (which may still be mid-tick) can recognize they're stale.
    const runId = Date.now() + Math.random();

    setAutoLabeling(modelId, mediaType, {
      url: null,
      isRunning: true,
      total: filteredImages.length,
      successes: 0,
      fails: [],
      uploaded: 0,
      phase: 'preparing',
      uploadStartedAt: null,
      runId,
    });

    // Materialize blobs from the same source URLs the legacy zip path used,
    // bounded so 500+ images don't all sit in memory at once. Bad URLs (e.g. CDN
    // returning a 403 HTML page) are recorded as per-image failures rather than
    // killing the whole run. Track failure reasons by image URL (collision-proof
    // — short filenames can collide for duplicate uploads).
    const failureReasons = new Map<string, string>();
    const keyToFilename = new Map<string, string>(
      filteredImages.map((i) => [i.url, getShortNameFromUrl(i)] as const)
    );
    const filenameFor = (key: string) => keyToFilename.get(key) ?? key;
    const recordFailure = (key: string, reason: string) => {
      if (key) failureReasons.set(key, reason);
    };

    type Sourced = { key: string; blob: Blob } | null;
    const sourced = await fetchWithConcurrency<(typeof filteredImages)[number], Sourced>(
      filteredImages,
      SOURCE_FETCH_CONCURRENCY,
      async (imgData) => {
        const key = imgData.url;
        try {
          const res = await fetch(imgData.url);
          if (!res.ok) {
            recordFailure(key, `Source fetch failed (${res.status} ${res.statusText})`);
            return null;
          }
          return { key, blob: await res.blob() };
        } catch (err) {
          recordFailure(key, err instanceof Error ? err.message : 'Source fetch failed');
          return null;
        }
      }
    );

    // If the user kicked off a different run while we were fetching, drop ours.
    if (useTrainingImageStore.getState()[modelId]?.autoLabeling.runId !== runId) return;

    const images = sourced.filter((s): s is { key: string; blob: Blob } => s !== null);
    // Push source-fetch failures into store immediately so the progress bar reflects them.
    if (failureReasons.size > 0) {
      mutateAutoLabeling(modelId, mediaType, (prev) => ({
        fails: [...prev.fails, ...failureReasons.keys()],
      }));
    }

    if (images.length === 0) {
      const defaultState = mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState;
      setAutoLabeling(modelId, mediaType, { ...defaultState.autoLabeling });
      showErrorNotification({
        title: 'Auto-label failed',
        error: new Error('Could not fetch any source images.'),
      });
      return;
    }

    const overwriteMode = (type === 'caption' ? autoCaptioning : autoTagging).overwrite;

    // All store mutations are gated on runId — if the user reset the run (close,
    // start fresh, etc.), the store's runId will differ and we no-op.
    const guard = (apply: () => void) => {
      if (useTrainingImageStore.getState()[modelId]?.autoLabeling.runId === runId) apply();
    };

    const onUploadStart = () => {
      guard(() =>
        mutateAutoLabeling(modelId, mediaType, () => ({
          phase: 'uploading',
          uploaded: 0,
          uploadStartedAt: Date.now(),
        }))
      );
    };
    const onUploadProgress = (uploadedCount: number) => {
      guard(() => mutateAutoLabeling(modelId, mediaType, () => ({ uploaded: uploadedCount })));
    };
    const onUploadComplete = () => {
      guard(() => mutateAutoLabeling(modelId, mediaType, () => ({ phase: 'labeling' })));
    };

    const onResult = (key: string, label: string) => {
      guard(() => {
        updateImage(modelId, mediaType, {
          matcher: filenameFor(key),
          urlMatcher: key,
          label,
          appendLabel: overwriteMode === 'append',
        });
        mutateAutoLabeling(modelId, mediaType, (prev) => ({ successes: prev.successes + 1 }));
      });
    };
    const onFailure = (key: string, reason: string) => {
      recordFailure(key, reason);
      if (!key) return;
      guard(() =>
        mutateAutoLabeling(modelId, mediaType, (prev) => ({ fails: [...prev.fails, key] }))
      );
    };
    const onFatal = (reason: string) => {
      // Catastrophic poll/setup failure — surface as a real toast rather than
      // hiding it in the per-image grouping.
      guard(() =>
        showErrorNotification({
          title: 'Auto-label crashed',
          error: new Error(reason),
          autoClose: false,
        })
      );
    };
    const onDone = ({ successes, failedKeys }: { successes: number; failedKeys: string[] }) => {
      // Drop late events from a stale run.
      if (useTrainingImageStore.getState()[modelId]?.autoLabeling.runId !== runId) return;

      const labelNoun = type === 'caption' ? 'caption' : 'tag';
      const labelVerb = type === 'caption' ? 'Captioned' : 'Tagged';

      // Union the helper's failedKeys with any source-fetch failures recorded
      // before submit — those never reach the helper, so they aren't in
      // failedKeys but are very much real failures the user should see.
      const allFailedKeys = new Set<string>(failedKeys);
      for (const key of failureReasons.keys()) allFailedKeys.add(key);

      // Group failure reasons so the user sees "5× content blocked" instead of
      // a flat count or 50 toasts.
      const reasonCounts = new Map<string, number>();
      for (const key of allFailedKeys) {
        const reason = failureReasons.get(key) ?? 'Unknown error';
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
      const reasonSummary = Array.from(reasonCounts.entries())
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([reason, count]) => `${count}× ${reason}`)
        .join('; ');

      const totalFails = allFailedKeys.size;
      const headline = `${labelVerb} ${successes} image${successes === 1 ? '' : 's'}.`;
      const failureText =
        totalFails > 0
          ? ` ${totalFails} failure${totalFails === 1 ? '' : 's'}${
              reasonSummary ? `: ${reasonSummary}` : ''
            }`
          : '';
      const message = headline + failureText;

      if (successes === 0) {
        showErrorNotification({
          title: `Auto-${labelNoun} failed`,
          error: new Error(message),
        });
      } else if (totalFails > 0) {
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
      const defaultState = mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState;
      setAutoLabeling(modelId, mediaType, { ...defaultState.autoLabeling });
      inFlightHandles.delete(modelId);
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
    // Pair `isRunning` with `runId` so a fresh run's `isRunning: true` doesn't
    // make a stale poll loop think it's still its own.
    const isActive = () => {
      const state = useTrainingImageStore.getState()[modelId]?.autoLabeling;
      return !!state?.isRunning && state.runId === runId;
    };

    try {
      const handle =
        type === 'tag'
          ? await uploadAndSubmitAutoLabel({
              modelId,
              mediaType: mediaType ?? 'image',
              type: 'tag',
              images,
              params: { threshold: autoTagging.threshold },
              postProcess,
              isActive,
              onUploadStart,
              onUploadProgress,
              onUploadComplete,
              onResult,
              onFailure,
              onFatal,
              onDone,
            })
          : await uploadAndSubmitAutoLabel({
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
              onUploadStart,
              onUploadProgress,
              onUploadComplete,
              onResult,
              onFailure,
              onFatal,
              onDone,
            });
      // Only stash the handle if we're still the live run — otherwise a newer
      // run's cancel could fire against our (now-stale) handle.
      if (useTrainingImageStore.getState()[modelId]?.autoLabeling.runId === runId) {
        inFlightHandles.set(modelId, handle);
      } else {
        handle.cancel();
      }
    } catch (e) {
      const defaultState = mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState;
      guard(() => setAutoLabeling(modelId, mediaType, { ...defaultState.autoLabeling }));
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
        // Hand off to the page-level progress card so the modal doesn't sit on
        // "Sending data..." through the entire upload+submit phase. The first
        // setAutoLabeling call inside submitViaOrchestrator runs synchronously
        // (zustand) so the store flips to isRunning: true before we close.
        void submitViaOrchestrator().catch((e) => {
          // Cancellation is expected (e.g. user starts a new run) — don't toast.
          if ((e as DOMException | undefined)?.name === 'AbortError') return;
          showErrorNotification({
            error: e instanceof Error ? e : new Error('Please try again'),
            title: 'Failed to send data',
            autoClose: false,
          });
        });
        handleClose();
      } else {
        await submitViaLegacyZip();
        handleClose();
      }
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
  const {
    loading,
    handleSubmit,
    numImages,
    disabled: limitReached,
  } = useSubmitImages({
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
            Auto-captioning is temporarily unavailable. We&apos;re actively looking into it - please
            check back soon.
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
