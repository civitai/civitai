import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import Router from 'next/router';
import { useCallback } from 'react';
import { MAX_TAGS, MIN_THRESHOLD } from '~/components/Resource/Forms/Training/TrainingAutoTagModal';
import { getCaptionAsList } from '~/components/Resource/Forms/Training/TrainingImages';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { TrainingUpdateSignalSchema } from '~/server/schema/signals.schema';
import { AutoTagResponse } from '~/server/services/training.service';
import { defaultTrainingState, trainingStore, useTrainingImageStore } from '~/store/training.store';
import { MyTrainingModelGetAll } from '~/types/router';
import { trpc } from '~/utils/trpc';

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

export const useTrainingAutoTagSignals = () => {
  const onUpdate = ({ modelId, data }: { modelId: number; data: AutoTagResponse }) => {
    const { updateImage, setAutoCaptioning } = trainingStore;

    Object.entries(data).forEach(([k, v]) => {
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
  };

  useSignalConnection(SignalMessages.TrainingAutoTag, onUpdate);
};
