import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import Router from 'next/router';
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { TrainingDetailsBaseModel } from '~/server/schema/model-version.schema';
import { TrainingUpdateSignalSchema } from '~/server/schema/signals.schema';
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
  const queryUtils = trpc.useContext();

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

const etaCoefficients = {
  models: {
    sdxl: 19.42979334,
    sd_1_5: -25.38624804,
    anime: -23.84022578,
    semi: -20.56343578,
    realistic: -50.28902011,
  },
  alpha: -0.649960841,
  dim: 0.792224422,
  steps: 0.014458002,
};

const dollarsPerMinute = 0.17 / 30;
const dollarsToBuzz = 1000;
const baseBuzzTake = 500;
const minEta = 1;

export const calcEta = (
  dim: number,
  alpha: number,
  steps: number,
  model: TrainingDetailsBaseModel | undefined
) => {
  if (!model || !(model in etaCoefficients.models)) return;

  return Math.max(
    minEta,
    etaCoefficients.models[model] +
      etaCoefficients.alpha * alpha +
      etaCoefficients.dim * dim +
      etaCoefficients.steps * steps
  );
};

export const calcBuzzFromEta = (eta: number) => {
  return Math.round(Math.max(baseBuzzTake, eta * dollarsPerMinute * dollarsToBuzz));
};
