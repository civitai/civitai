import type {
  FluxDevFastImageResourceTrainingInput,
  ImageResourceTrainingStep,
  ImageResourceTrainingStepTemplate,
  KohyaImageResourceTrainingInput,
  MusubiImageResourceTrainingInput,
} from '@civitai/client';
import { env } from '~/env/server';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import type {
  ImageTrainingStepSchema,
  ImageTrainingWorkflowSchema,
  ImageTraininWhatIfWorkflowSchema,
} from '~/server/schema/orchestrator/training.schema';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import type { TrainingRequest } from '~/server/services/training.service';
import { getTrainingServiceStatus } from '~/server/services/training.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { getGetUrl } from '~/utils/s3-utils';
import { parseAIRSafe } from '~/utils/string-helpers';
import { getTrainingFields, isInvalidRapid, trainingModelInfo } from '~/utils/training';

async function isSafeTensor(modelVersionId: number) {
  // it's possible we need to modify this if a model somehow has pickle and safetensor
  const [data] = await dbWrite.$queryRaw<{ fmt: string }[]>`
    SELECT mf.metadata ->> 'format' as fmt
    FROM "ModelVersion" mv
           JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Model'
           JOIN "Model" m ON m.id = mv."modelId"
    WHERE mv.id = ${modelVersionId}
    LIMIT 1
  `;

  return data?.fmt === 'SafeTensor';
}

const checkCustomModel = async (
  model: string,
  check_st = true
): Promise<
  | {
      ok: true;
    }
  | { ok: false; message: string }
> => {
  if (model in trainingModelInfo) return { ok: true };

  const mMatch = parseAIRSafe(model);
  if (!mMatch) return { ok: false, message: 'Invalid structure for custom model.' };

  if (check_st) {
    const isST = await isSafeTensor(mMatch.version);
    if (!isST)
      return {
        ok: false,
        message: 'Custom model does not have a SafeTensor file. Please choose another model.',
      };
  }

  return { ok: true };
};

const createTrainingStep_Run = (
  input: ImageTrainingStepSchema
): ImageResourceTrainingStepTemplate => {
  const {
    model,
    priority,
    engine,
    loraName,
    modelFileId,
    params,
    trainingData,
    trainingDataImagesCount,
    samplePrompts,
  } = input;

  const base = {
    $type: 'imageResourceTraining',
    metadata: {
      modelFileId,
    },
    priority,
    retries: constants.maxTrainingRetries,
    // timeout
    // name
  } as const;

  const inputBase = {
    loraName,
    model,
    trainingData,
    trainingDataImagesCount,
    samplePrompts,
  };

  if (engine === 'kohya') {
    const input: KohyaImageResourceTrainingInput = {
      ...inputBase,
      ...params,
      engine,
    };
    return {
      ...base,
      input,
    };
  } else if (engine === 'flux-dev-fast') {
    const input: FluxDevFastImageResourceTrainingInput = {
      ...inputBase,
      engine,
    };
    return {
      ...base,
      input,
    };
  } else if (engine === 'musubi') {
    const input: MusubiImageResourceTrainingInput = {
      ...inputBase,
      ...params,
      engine,
    };
    return {
      ...base,
      input,
    };
  } else {
    throw new Error('Invalid engine for training');
  }
};

export const createTrainingWorkflow = async ({
  modelVersionId,
  token,
  user,
}: ImageTrainingWorkflowSchema) => {
  const { id: userId, isModerator } = user;

  const status = await getTrainingServiceStatus();
  if (!status.available && !isModerator)
    throw throwBadRequestError(status.message ?? 'Training is currently disabled');

  const modelVersions = await dbWrite.$queryRaw<TrainingRequest[]>`
    SELECT mv."trainingDetails",
           m.name      "modelName",
           m."userId",
           mf.url      "trainingUrl",
           mf.id       "fileId",
           mf.metadata "fileMetadata",
           mv.id       "modelVersionId"
    FROM "ModelVersion" mv
           JOIN "Model" m ON m.id = mv."modelId"
           JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
    WHERE mv.id = ${modelVersionId}
      AND m."deletedAt" is null
  `;

  if (modelVersions.length === 0) throw throwBadRequestError('Invalid model version');
  const modelVersion = modelVersions[0];

  // Don't allow a user to queue anything but their own training
  if (userId !== modelVersion.userId) throw throwBadRequestError('Invalid user');

  const trainingParams = modelVersion.trainingDetails.params;
  if (!trainingParams) throw throwBadRequestError('Missing training params');

  const baseModel = modelVersion.trainingDetails.baseModel;
  if (!baseModel) throw throwBadRequestError('Missing base model');
  if ((status.blockedModels ?? []).includes(baseModel))
    throw throwBadRequestError(
      'This model has been blocked from training - please try another one.'
    );

  const baseModelType = modelVersion.trainingDetails.baseModelType ?? 'sd15';
  const samplePrompts = modelVersion.trainingDetails.samplePrompts ?? ['', '', ''];
  const isPriority = modelVersion.trainingDetails.highPriority ?? false;
  const fileMetadata = modelVersion.fileMetadata ?? {};
  const trainingDataImagesCount = fileMetadata.numImages ?? 1;
  // const trainingResults = (fileMetadata.trainingResults ?? {}) as TrainingResultsV2;

  if (isInvalidRapid(baseModelType, trainingParams.engine))
    throw throwBadRequestError('Cannot use Rapid Training with a non-flux base model.');

  const { url: trainingData } = await getGetUrl(modelVersion.trainingUrl);

  if (!(baseModel in trainingModelInfo)) {
    const customCheck = await checkCustomModel(baseModel);
    if (!customCheck.ok) {
      throw throwBadRequestError(customCheck.message);
    }
  }

  const model = getTrainingFields.getModel(baseModel);
  const priority = getTrainingFields.getPriority(isPriority);
  const engine = getTrainingFields.getEngine(trainingParams.engine);
  const loraName = modelVersion.modelName;
  const modelFileId = modelVersion.fileId;
  const params = {
    ...trainingParams,
    engine,
  };

  const runArgs: ImageTrainingStepSchema = {
    model,
    priority,
    trainingData,
    trainingDataImagesCount,
    engine,
    loraName,
    samplePrompts,
    modelFileId,
    params,
  };

  const stepRun = createTrainingStep_Run(runArgs);

  const workflow = await submitWorkflow({
    token,
    body: {
      tags: ['training'],
      steps: [stepRun],
      callbacks: [
        {
          url: `${env.WEBHOOK_URL}/resource-training-v2/${modelVersion.modelVersionId}?token=${env.WEBHOOK_TOKEN}`,
          type: ['workflow:*'],
        },
      ],
    },
  });

  // check workflow.status?

  return workflow;
};

export const createTrainingWhatIfWorkflow = async ({
  token,
  ...input
}: ImageTraininWhatIfWorkflowSchema) => {
  const { model, priority, engine, trainingDataImagesCount, ...trainingParams } = input;

  const params = {
    ...trainingParams,
    engine,
  };

  const runArgs: ImageTrainingStepSchema = {
    model,
    priority,
    engine,
    trainingDataImagesCount,
    params,
    trainingData: '',
    loraName: '',
    samplePrompts: ['', '', ''],
    modelFileId: -1,
  };

  const stepRun = createTrainingStep_Run(runArgs);

  const workflow = await submitWorkflow({
    token,
    body: {
      steps: [stepRun],
    },
    query: { whatif: true },
  });

  const cost = workflow.cost?.total;

  const _step = workflow.steps?.[0] as ImageResourceTrainingStep | undefined;
  // console.dir(_step);
  const precedingJobs = _step?.jobs?.[0]?.queuePosition?.precedingJobs;
  const eta = _step?.output?.eta;

  return { cost, precedingJobs, eta };
};
