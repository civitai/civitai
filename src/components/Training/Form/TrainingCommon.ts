import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import Router from 'next/router';
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { MAX_TAGS, MIN_THRESHOLD } from '~/components/Training/Form/TrainingAutoTagModal';
import { getCaptionAsList } from '~/components/Training/Form/TrainingImages';
import { SignalMessages } from '~/server/common/enums';
import { Orchestrator } from '~/server/http/orchestrator/orchestrator.types';
import type { TrainingUpdateSignalSchema } from '~/server/schema/signals.schema';
import type { AutoTagResponse, TagDataResponse } from '~/server/services/training.service';
import { defaultTrainingState, trainingStore, useTrainingImageStore } from '~/store/training.store';
import { MyTrainingModelGetAll } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export const basePath = '/models/train';
export const maxSteps = 3;
export const blockedCustomModels = ['civitai:53761@285757'];

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

export const isTrainingCustomModel = (m: string | null) => {
  if (!m) return false;
  return m.startsWith('civitai:');
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
    context?: { data: TagDataResponse; modelId: number; isDone: boolean };
    jobProperties?: { modelId: number };
    jobType: string;
    type: Orchestrator.JobStatus;
  }) => {
    if (jobType !== 'MediaTagging') return;

    // TODO we could handle Initialized | Claimed | Succeeded
    if (!['Updated', 'Failed'].includes(type)) return;

    if (!isDefined(jobProperties)) return;
    const { modelId } = jobProperties;
    const { updateImage, setAutoCaptioning } = trainingStore;

    if (type === 'Failed') {
      showErrorNotification({
        error: new Error('Could not complete. Please try again.'),
        title: 'Failed to auto-tag',
        autoClose: false,
      });
      setAutoCaptioning(modelId, { ...defaultTrainingState.autoCaptioning });
      return;
    }

    if (!isDefined(context)) return;
    const { data, isDone } = context;

    const tagList = Object.entries(data).map(([f, t]) => ({
      [f]: t.wdTagger.tags,
    }));
    const returnData: AutoTagResponse = Object.assign({}, ...tagList);

    Object.entries(returnData).forEach(([k, v]) => {
      const returnData = Object.entries(v);
      const storeState = useTrainingImageStore.getState();
      const { autoCaptioning } = storeState[modelId] ?? { ...defaultTrainingState };

      const blacklist = getCaptionAsList(autoCaptioning.blacklist ?? '');
      const prependList = getCaptionAsList(autoCaptioning.prependTags ?? '');
      const appendList = getCaptionAsList(autoCaptioning.appendTags ?? '');

      if (returnData.length === 0) {
        setAutoCaptioning(modelId, { ...autoCaptioning, fails: [...autoCaptioning.fails, k] });
      } else {
        let tags = returnData
          .sort(([, a], [, b]) => b - a)
          .filter(
            (t) => t[1] >= (autoCaptioning.threshold ?? MIN_THRESHOLD) && !blacklist.includes(t[0])
          )
          .slice(0, autoCaptioning.maxTags ?? MAX_TAGS)
          .map((t) => t[0]);

        tags = [...prependList, ...tags, ...appendList];

        updateImage(modelId, {
          matcher: k,
          caption: tags.join(', '),
          appendCaption: autoCaptioning.overwrite === 'append',
        });
        setAutoCaptioning(modelId, { ...autoCaptioning, successes: autoCaptioning.successes + 1 });
      }
    });

    if (isDone) {
      const storeState = useTrainingImageStore.getState();
      const { autoCaptioning } = storeState[modelId] ?? { ...defaultTrainingState };
      showSuccessNotification({
        title: 'Images auto-tagged successfully!',
        message: `Tagged ${autoCaptioning.successes} image${
          autoCaptioning.successes === 1 ? '' : 's'
        }. Failures: ${autoCaptioning.fails.length}`,
      });
      setAutoCaptioning(modelId, { ...defaultTrainingState.autoCaptioning });
    }
  };
  useSignalConnection(SignalMessages.OrchestratorUpdate, onUpdate);
};
