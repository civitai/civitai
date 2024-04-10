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
import { TrainingUpdateSignalSchema } from '~/server/schema/signals.schema';
import { AutoTagResponse, TagDataResponse } from '~/server/services/training.service';
import { defaultTrainingState, trainingStore, useTrainingImageStore } from '~/store/training.store';
import { MyTrainingModelGetAll } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export const basePath = '/models/train';
export const maxSteps = 3;

// these could use the current route to determine?
export const goNext = (modelId: number | undefined, step: number) => {
  if (modelId && step < maxSteps)
    Router.replace(`${basePath}?modelId=${modelId}&step=${step + 1}`, undefined, {
      shallow: true,
      scroll: true,
    });
};
export const goBack = (modelId: number | undefined, step: number) => {
  if (modelId && step > 1)
    Router.replace(`${basePath}?modelId=${modelId}&step=${step - 1}`, undefined, {
      shallow: true,
      scroll: true,
    });
};

export const isTrainingCustomModel = (m: string | null) => {
  if (!m) return false;
  return m.startsWith('civitai:');
};

export const blockedCustomModels = ['civitai:53761@285757'];

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
          const model = old?.items?.find((x) => x.id == updated.modelId);
          const mv = model?.modelVersions[0];
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
          const mv = old.modelVersions[0];
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
