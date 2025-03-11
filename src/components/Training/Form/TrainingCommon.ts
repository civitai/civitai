import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import Router from 'next/router';
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { Orchestrator } from '~/server/http/orchestrator/orchestrator.types';
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
    jobProperties?: { modelId: number; userId: number };
    jobType: string;
    type: Orchestrator.JobStatus;
  }) => {
    // console.log({ jobType, context, jobProperties, type });
    if (!['MediaTagging', 'MediaCaptioning'].includes(jobType)) return;

    // TODO we could handle Initialized | Claimed | Succeeded
    if (!['Updated', 'Failed'].includes(type)) return;

    if (!isDefined(jobProperties)) return;
    const { modelId } = jobProperties;
    const storeState = useTrainingImageStore.getState();
    const { autoLabeling, autoTagging, autoCaptioning } = storeState[modelId] ?? {
      ...defaultTrainingState,
    };
    const { updateImage, setAutoLabeling } = trainingStore;

    if (type === 'Failed') {
      showErrorNotification({
        error: new Error('Could not complete. Please try again.'),
        title: 'Failed to auto label',
        autoClose: false,
      });
      setAutoLabeling(modelId, { ...defaultTrainingState.autoLabeling });
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
          setAutoLabeling(modelId, { ...autoLabeling, fails: [...autoLabeling.fails, k] });
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

          updateImage(modelId, {
            matcher: k,
            label: tags.join(', '),
            appendLabel: autoTagging.overwrite === 'append',
          });
          setAutoLabeling(modelId, { ...autoLabeling, successes: autoLabeling.successes + 1 });
        }
      });
    } else {
      data = context.data as CaptionDataResponse;

      const tagList = Object.entries(data).map(([f, t]) => ({
        [f]: t.joyCaption.caption,
      }));
      const returnData: AutoCaptionResponse = Object.assign({}, ...tagList);

      Object.entries(returnData).forEach(([k, v]) => {
        if (v.length === 0) {
          setAutoLabeling(modelId, { ...autoLabeling, fails: [...autoLabeling.fails, k] });
        } else {
          updateImage(modelId, {
            matcher: k,
            label: v,
            appendLabel: autoCaptioning.overwrite === 'append',
          });
          setAutoLabeling(modelId, { ...autoLabeling, successes: autoLabeling.successes + 1 });
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
      setAutoLabeling(modelId, { ...defaultTrainingState.autoLabeling });
    }
  };
  useSignalConnection(SignalMessages.OrchestratorUpdate, onUpdate);
};
