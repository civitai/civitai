import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import Router from 'next/router';
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { auditPrompt } from '~/utils/metadata/audit';
import { SignalMessages } from '~/server/common/enums';
import type { Orchestrator } from '~/server/http/orchestrator/orchestrator.types';
import type { TrainingUpdateSignalSchema } from '~/server/schema/signals.schema';
import type {
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

// =============================================================================
// Auto-label post-processing
//
// Pure helpers that turn raw orchestrator output into the final label string.
// Shared by the legacy signal-driven path and the orchestrator workflow path.
// =============================================================================

export type TagPostProcessOptions = {
  blacklist?: string;
  prependTags?: string;
  appendTags?: string;
  maxTags?: number;
  threshold?: number;
};

/** Filter, prepend/append, and safety-audit raw wd-tagger output. Returns an empty
 *  array when the input was empty so callers can record a per-image failure. */
export const applyTagPostProcess = (
  rawTags: { [tag: string]: number } | undefined | null,
  opts: TagPostProcessOptions
): string[] => {
  const entries = Object.entries(rawTags ?? {});
  if (entries.length === 0) return [];

  const blacklist = new Set(getTextTagsAsList(opts.blacklist ?? ''));
  const prependList = getTextTagsAsList(opts.prependTags ?? '');
  const appendList = getTextTagsAsList(opts.appendTags ?? '');

  let tags = entries
    .sort(([, a], [, b]) => b - a)
    .filter(
      ([t, score]) =>
        score >= (opts.threshold ?? autoLabelLimits.tag.threshold.min) && !blacklist.has(t)
    )
    .slice(0, opts.maxTags ?? autoLabelLimits.tag.tags.max)
    .map(([t]) => t);

  tags = [...prependList, ...tags, ...appendList];
  // Drop any individual tag that trips our prompt safety filter — no PII / banned terms.
  tags = tags.filter((tag) => auditPrompt(tag).success);

  return tags;
};

/** Trim caption output. Returns null when the orchestrator returned an empty
 *  string so callers can record a per-image failure. */
export const applyCaptionPostProcess = (rawCaption: string | undefined | null): string | null => {
  const trimmed = (rawCaption ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
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

    if (jobType === 'MediaTagging') {
      const data = context.data as TagDataResponse;
      Object.entries(data).forEach(([filename, payload]) => {
        const tags = applyTagPostProcess(payload.wdTagger.tags, autoTagging);
        if (tags.length === 0) {
          setAutoLabeling(modelId, mediaType, {
            ...autoLabeling,
            fails: [...autoLabeling.fails, filename],
          });
          return;
        }
        updateImage(modelId, mediaType, {
          matcher: filename,
          label: tags.join(', '),
          appendLabel: autoTagging.overwrite === 'append',
        });
        setAutoLabeling(modelId, mediaType, {
          ...autoLabeling,
          successes: autoLabeling.successes + 1,
        });
      });
    } else {
      const data = context.data as CaptionDataResponse;
      Object.entries(data ?? {}).forEach(([filename, payload]) => {
        const caption = applyCaptionPostProcess(payload.joyCaption?.caption);
        if (!caption) {
          setAutoLabeling(modelId, mediaType, {
            ...autoLabeling,
            fails: [...autoLabeling.fails, filename],
          });
          return;
        }
        updateImage(modelId, mediaType, {
          matcher: filename,
          label: caption,
          appendLabel: autoCaptioning.overwrite === 'append',
        });
        setAutoLabeling(modelId, mediaType, {
          ...autoLabeling,
          successes: autoLabeling.successes + 1,
        });
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
