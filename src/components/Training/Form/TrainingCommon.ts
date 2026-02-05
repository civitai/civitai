import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import Router from 'next/router';
import { useCallback, useEffect, useRef } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import type { Orchestrator } from '~/server/http/orchestrator/orchestrator.types';
import type { TrainingUpdateSignalSchema } from '~/server/schema/signals.schema';
import type {
  AutoCaptionResponse,
  AutoTagResponse,
  CaptionDataResponse,
  TagDataResponse,
} from '~/server/services/training.service';
import {
  autoLabelLimits,
  defaultTrainingState,
  defaultTrainingStateVideo,
  trainingStore,
  useTrainingImageStore,
} from '~/store/training.store';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import type { MyTrainingModelGetAll } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export const basePath = '/models/train';
export const maxSteps = 3;

// nb: these should be proper AIRs now
export const blockedCustomModels = [
  'civitai:53761@285757',
  'urn:air:sd1:checkpoint:civitai:53761@285757',
];

/**
 * Computes the number of decimal points in a given input using magic math
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getPrecision = (n: any) => {
  if (!isFinite(n)) return 0;
  const e = 1;
  let p = 0;
  while (Math.round(n * e) / e !== n) {
    n *= 10;
    p++;
  }
  return p;
};

export const minsToHours = (n: number) => {
  if (!n) return 'Unknown';

  const hours = Math.floor(n / 60);
  const minutes = Math.floor(n % 60);

  const h = hours > 0 ? `${hours} hour${hours === 1 ? '' : 's'}, ` : '';
  const m = `${minutes} min${minutes === 1 ? '' : 's'}`;

  return `${h}${m}`;
};

export const getTextTagsAsList = (txt: string) => {
  return txt
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
};

// these could use the current route to determine?
export const goNext = (modelId: number | undefined, step: number, cb?: VoidFunction) => {
  if (modelId && step < maxSteps)
    Router.replace(`${basePath}?modelId=${modelId}&step=${step + 1}`, undefined, {
      shallow: true,
      scroll: true,
    }).then(() => cb?.());
};
export const goBack = (modelId: number | undefined, step: number) => {
  if (modelId && step > 1)
    Router.replace(`${basePath}?modelId=${modelId}&step=${step - 1}`, undefined, {
      shallow: true,
      scroll: true,
    }).then();
};

export const useTrainingSignals = () => {
  const queryClient = useQueryClient();
  const queryUtils = trpc.useUtils();

  const onUpdate = useCallback(
    (updated: TrainingUpdateSignalSchema) => {
      // Update training model view
      const queryKey = getQueryKey(trpc.model.getMyTrainingModels);
      queryClient.setQueriesData(
        { queryKey, exact: false },
        produce((old: MyTrainingModelGetAll | undefined) => {
          const mv = old?.items?.find((x) => x.id == updated.modelVersionId);
          if (mv) {
            mv.trainingStatus = updated.status;
            const mFile = mv.files[0];
            if (mFile) {
              mFile.metadata = updated.fileMetadata;
            }
          }
        })
      );

      // Update select file page
      queryUtils.model.getById.setData(
        { id: updated.modelId },
        produce((old) => {
          if (!old) return old;
          const mv = old.modelVersions.find((x) => x.id == updated.modelVersionId);
          if (mv) {
            mv.trainingStatus = updated.status;
            const mFile = mv.files.find((f) => f.type === 'Training Data');
            if (mFile) {
              // TODO [bw] why is this complaining about null in ModelFileFormat?
              // @ts-ignore
              mFile.metadata = updated.fileMetadata;
            }
          }
        })
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient]
  );

  useSignalConnection(SignalMessages.TrainingUpdate, onUpdate);
};

export const useOrchestratorUpdateSignal = () => {
  const onUpdate = ({
    context,
    jobProperties,
    jobType,
    type,
  }: {
    context?: { data: TagDataResponse | CaptionDataResponse; modelId: number; isDone: boolean };
    jobProperties?: Orchestrator.Training.ImageAutoTagJobPayload['properties'];
    jobType: string;
    type: Orchestrator.JobStatus;
  }) => {
    // console.log({ jobType, context, jobProperties, type });
    if (!['MediaTagging', 'MediaCaptioning'].includes(jobType)) return;

    // TODO we could handle Initialized | Claimed | Succeeded
    if (!['Updated', 'Failed'].includes(type)) return;

    if (!isDefined(jobProperties)) return;
    const { modelId, mediaType: mt } = jobProperties;
    const storeState = useTrainingImageStore.getState();

    // TODO get the mediaType back so we know which training state to use
    const mediaType = mt ?? 'image';
    const defaultState = mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState;

    const { autoLabeling, autoTagging, autoCaptioning } = storeState[modelId] ?? {
      ...defaultState,
    };
    const { updateImage, setAutoLabeling } = trainingStore;

    if (type === 'Failed') {
      showErrorNotification({
        error: new Error('Could not complete. Please try again.'),
        title: 'Failed to auto label',
        autoClose: false,
      });
      setAutoLabeling(modelId, mediaType, { ...defaultState.autoLabeling });
      return;
    }

    if (!isDefined(context)) return;
    const { isDone } = context;

    let data: TagDataResponse | CaptionDataResponse;
    if (jobType === 'MediaTagging') {
      data = context.data as TagDataResponse;

      const tagList = Object.entries(data).map(([f, t]) => ({
        [f]: t.wdTagger.tags,
      }));
      const returnData: AutoTagResponse = Object.assign({}, ...tagList);

      Object.entries(returnData).forEach(([k, v]) => {
        const returnDataList = Object.entries(v);

        const blacklist = getTextTagsAsList(autoTagging.blacklist ?? '');
        const prependList = getTextTagsAsList(autoTagging.prependTags ?? '');
        const appendList = getTextTagsAsList(autoTagging.appendTags ?? '');

        if (returnDataList.length === 0) {
          setAutoLabeling(modelId, mediaType, {
            ...autoLabeling,
            fails: [...autoLabeling.fails, k],
          });
        } else {
          let tags = returnDataList
            .sort(([, a], [, b]) => b - a)
            .filter(
              (t) =>
                t[1] >= (autoTagging.threshold ?? autoLabelLimits.tag.threshold.min) &&
                !blacklist.includes(t[0])
            )
            .slice(0, autoTagging.maxTags ?? autoLabelLimits.tag.tags.max)
            .map((t) => t[0]);

          tags = [...prependList, ...tags, ...appendList];

          updateImage(modelId, mediaType, {
            matcher: k,
            label: tags.join(', '),
            appendLabel: autoTagging.overwrite === 'append',
          });
          setAutoLabeling(modelId, mediaType, {
            ...autoLabeling,
            successes: autoLabeling.successes + 1,
          });
        }
      });
    } else {
      data = context.data as CaptionDataResponse;

      const tagList = Object.entries(data ?? {}).map(([f, t]) => ({
        [f]: t.joyCaption?.caption ?? '',
      }));
      const returnData: AutoCaptionResponse = Object.assign({}, ...tagList);

      Object.entries(returnData).forEach(([k, v]) => {
        if (v.length === 0) {
          setAutoLabeling(modelId, mediaType, {
            ...autoLabeling,
            fails: [...autoLabeling.fails, k],
          });
        } else {
          updateImage(modelId, mediaType, {
            matcher: k,
            label: v,
            appendLabel: autoCaptioning.overwrite === 'append',
          });
          setAutoLabeling(modelId, mediaType, {
            ...autoLabeling,
            successes: autoLabeling.successes + 1,
          });
        }
      });
    }

    if (isDone) {
      showSuccessNotification({
        title: 'Images auto-labeled successfully!',
        message: `Tagged ${autoLabeling.successes} image${
          autoLabeling.successes === 1 ? '' : 's'
        }. Failures: ${autoLabeling.fails.length}`,
      });
      setAutoLabeling(modelId, mediaType, { ...defaultState.autoLabeling });
    }
  };
  useSignalConnection(SignalMessages.OrchestratorUpdate, onUpdate);
};

// Polling interval in ms (5 seconds)
const POLLING_INTERVAL = 5000;
// Delay before starting polling to give signals a chance (10 seconds)
const POLLING_START_DELAY = 10000;

/**
 * Polling fallback hook for auto-labeling jobs.
 * Polls for job status when signals don't arrive within the expected timeframe.
 */
export const useAutoLabelPolling = (
  modelId: number,
  mediaType: TrainingDetailsObj['mediaType'],
  labelType: 'tag' | 'caption'
) => {
  const storeState = useTrainingImageStore.getState();
  const { autoLabeling } =
    storeState[modelId] ??
    (mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState);
  const { updateImage, setAutoLabeling } = trainingStore;
  const defaultState = mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState;

  const pollingStartTimeRef = useRef<number | null>(null);
  const hasReceivedSignalRef = useRef(false);

  const { refetch } = trpc.training.getAutoLabelJobStatus.useQuery(
    { token: autoLabeling.jobToken ?? '' },
    {
      enabled: false, // Manual control
      retry: false,
    }
  );

  // Process job status results
  const processJobResults = useCallback(
    (jobs: Orchestrator.JobStatusItem[]) => {
      const currentState = useTrainingImageStore.getState();
      const currentAutoLabeling = currentState[modelId]?.autoLabeling ?? defaultState.autoLabeling;
      const currentAutoTagging = currentState[modelId]?.autoTagging ?? defaultState.autoTagging;
      const currentAutoCaptioning =
        currentState[modelId]?.autoCaptioning ?? defaultState.autoCaptioning;

      for (const job of jobs) {
        // Skip jobs that are still in progress
        if (job.scheduled || !job.lastEvent) continue;

        const { type: eventType, jobHasCompleted } = job.lastEvent;

        // Check if job failed
        if (eventType === 'Failed') {
          showErrorNotification({
            error: new Error('Could not complete. Please try again.'),
            title: 'Failed to auto label',
            autoClose: false,
          });
          setAutoLabeling(modelId, mediaType, { ...defaultState.autoLabeling });
          return;
        }

        // Check if job completed - results are in job.result, not lastEvent.context
        if (eventType === 'Succeeded' && jobHasCompleted) {
          // The result contains the tagging/captioning data
          const result = job.result as { data?: TagDataResponse | CaptionDataResponse } | undefined;
          const data = result?.data;

          // Skip if no data in result
          if (!data) {
            // Job completed but no data - mark as done anyway
            showSuccessNotification({
              title: 'Auto-labeling job completed',
              message: 'Job finished but no results were returned. Results may have been delivered via signals.',
            });
            setAutoLabeling(modelId, mediaType, { ...defaultState.autoLabeling });
            return;
          }

          // We have data, process it
          const isDone = true; // Job is completed

          if (labelType === 'tag') {
            const tagData = data as TagDataResponse;
            if (!tagData || typeof tagData !== 'object') continue;

            const tagList = Object.entries(tagData).map(([f, t]) => ({
              [f]: t?.wdTagger?.tags ?? {},
            }));
            const returnData: AutoTagResponse = Object.assign({}, ...tagList);

            Object.entries(returnData).forEach(([k, v]) => {
              const returnDataList = Object.entries(v);
              const blacklist = getTextTagsAsList(currentAutoTagging.blacklist ?? '');
              const prependList = getTextTagsAsList(currentAutoTagging.prependTags ?? '');
              const appendList = getTextTagsAsList(currentAutoTagging.appendTags ?? '');

              if (returnDataList.length === 0) {
                setAutoLabeling(modelId, mediaType, {
                  ...currentAutoLabeling,
                  fails: [...currentAutoLabeling.fails, k],
                });
              } else {
                let tags = returnDataList
                  .sort(([, a], [, b]) => b - a)
                  .filter(
                    (t) =>
                      t[1] >= (currentAutoTagging.threshold ?? autoLabelLimits.tag.threshold.min) &&
                      !blacklist.includes(t[0])
                  )
                  .slice(0, currentAutoTagging.maxTags ?? autoLabelLimits.tag.tags.max)
                  .map((t) => t[0]);

                tags = [...prependList, ...tags, ...appendList];

                updateImage(modelId, mediaType, {
                  matcher: k,
                  label: tags.join(', '),
                  appendLabel: currentAutoTagging.overwrite === 'append',
                });
                setAutoLabeling(modelId, mediaType, {
                  ...currentAutoLabeling,
                  successes: currentAutoLabeling.successes + 1,
                });
              }
            });
          } else {
            const captionData = data as CaptionDataResponse;
            if (!captionData || typeof captionData !== 'object') continue;

            const tagList = Object.entries(captionData).map(([f, t]) => ({
              [f]: t?.joyCaption?.caption ?? '',
            }));
            const returnData: AutoCaptionResponse = Object.assign({}, ...tagList);

            Object.entries(returnData).forEach(([k, v]) => {
              if (v.length === 0) {
                setAutoLabeling(modelId, mediaType, {
                  ...currentAutoLabeling,
                  fails: [...currentAutoLabeling.fails, k],
                });
              } else {
                updateImage(modelId, mediaType, {
                  matcher: k,
                  label: v,
                  appendLabel: currentAutoCaptioning.overwrite === 'append',
                });
                setAutoLabeling(modelId, mediaType, {
                  ...currentAutoLabeling,
                  successes: currentAutoLabeling.successes + 1,
                });
              }
            });
          }

          if (isDone) {
            const finalState = useTrainingImageStore.getState();
            const finalAutoLabeling =
              finalState[modelId]?.autoLabeling ?? defaultState.autoLabeling;

            showSuccessNotification({
              title: 'Images auto-labeled successfully!',
              message: `Tagged ${finalAutoLabeling.successes} image${
                finalAutoLabeling.successes === 1 ? '' : 's'
              }. Failures: ${finalAutoLabeling.fails.length}`,
            });
            setAutoLabeling(modelId, mediaType, { ...defaultState.autoLabeling });
          }
        }
      }
    },
    [modelId, mediaType, labelType, updateImage, setAutoLabeling, defaultState]
  );

  // Polling effect
  useEffect(() => {
    if (!autoLabeling.isRunning || !autoLabeling.jobToken) {
      pollingStartTimeRef.current = null;
      return;
    }

    // Set start time for polling delay
    if (!pollingStartTimeRef.current) {
      pollingStartTimeRef.current = Date.now();
    }

    const pollInterval = setInterval(async () => {
      // Wait for initial delay before polling
      if (Date.now() - (pollingStartTimeRef.current ?? 0) < POLLING_START_DELAY) {
        return;
      }

      // Check if we should still be polling
      const currentState = useTrainingImageStore.getState();
      const currentAutoLabeling = currentState[modelId]?.autoLabeling;
      if (!currentAutoLabeling?.isRunning || !currentAutoLabeling?.jobToken) {
        clearInterval(pollInterval);
        return;
      }

      try {
        const result = await refetch();
        if (result.data?.jobs) {
          processJobResults(result.data.jobs);
        }
      } catch (error) {
        console.error('Failed to poll job status:', error);
      }
    }, POLLING_INTERVAL);

    return () => clearInterval(pollInterval);
  }, [autoLabeling.isRunning, autoLabeling.jobToken, modelId, refetch, processJobResults]);

  // Mark that we received a signal (to potentially disable polling)
  const markSignalReceived = useCallback(() => {
    hasReceivedSignalRef.current = true;
  }, []);

  return { markSignalReceived };
};
