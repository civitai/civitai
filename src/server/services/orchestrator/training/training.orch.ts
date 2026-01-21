import type {
  FluxDevFastImageResourceTrainingInput,
  ImageResourceTrainingStep,
  ImageResourceTrainingStepTemplate,
  KohyaImageResourceTrainingInput,
  MusubiImageResourceTrainingInput,
  TrainingStepTemplate,
  ZipTrainingData,
  AiToolkitTrainingInput,
  SdxlAiToolkitTrainingInput,
  Sd1AiToolkitTrainingInput,
} from '@civitai/client';
import { env } from '~/env/server';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import type { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import type {
  AiToolkitTrainingParams,
  ImageTrainingStepSchema,
  ImageTrainingWorkflowSchema,
  ImageTraininWhatIfWorkflowSchema,
} from '~/server/schema/orchestrator/training.schema';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import type { TrainingRequest } from '~/server/services/training.service';
import { getTrainingServiceStatus } from '~/server/services/training.service';
import { throwBadRequestError, throwInternalServerError } from '~/server/utils/errorHandling';
import { TrainingStatus } from '~/shared/utils/prisma/enums';
import { getGetUrl } from '~/utils/s3-utils';
import { parseAIRSafe } from '~/utils/string-helpers';
import {
  getTrainingFields,
  isInvalidRapid,
  isInvalidAiToolkit,
  trainingModelInfo,
} from '~/utils/training';

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
    negativePrompt,
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
    negativePrompt,
  };

  if (engine === 'kohya') {
    const input: KohyaImageResourceTrainingInput = {
      ...inputBase,
      ...(params as any),
      engine,
    };
    return {
      ...base,
      input,
    };
  } else if (engine === 'flux-dev-fast' || engine === 'flux2-dev' || engine === 'flux2-dev-edit') {
    // All rapid/fast training engines use the same input structure
    // Type assertion needed because flux2 engine types aren't in @civitai/client yet
    const input = {
      ...inputBase,
      engine,
    } as FluxDevFastImageResourceTrainingInput;
    return {
      ...base,
      input,
    };
  } else if (engine === 'musubi') {
    const input: MusubiImageResourceTrainingInput = {
      ...inputBase,
      ...(params as any),
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

// NEW: Create training step using the new TrainingStep format (for ai-toolkit)
const createTrainingStep_AiToolkit = (input: ImageTrainingStepSchema): TrainingStepTemplate => {
  const {
    model,
    priority,
    loraName,
    trainingData,
    trainingDataImagesCount,
    samplePrompts,
    negativePrompt,
    modelFileId,
    params,
  } = input;

  // Params are already in AI Toolkit format from the database
  const aiToolkitParams = params as AiToolkitTrainingParams;

  let trainingInput: AiToolkitTrainingInput = {
    engine: 'ai-toolkit',
    ecosystem: aiToolkitParams.ecosystem as any, // Type assertion for new ecosystems (qwen, chroma) until @civitai/client is updated

    ...(aiToolkitParams.modelVariant && { modelVariant: aiToolkitParams.modelVariant }),
    trainingData: {
      type: 'zip',
      sourceUrl: trainingData,
      count: trainingDataImagesCount,
    } as ZipTrainingData,
    samples: {
      prompts: samplePrompts,
    },
    epochs: aiToolkitParams.epochs,
    lr: aiToolkitParams.lr,
    textEncoderLr: aiToolkitParams.textEncoderLr ?? undefined,
    trainTextEncoder: aiToolkitParams.trainTextEncoder,
    lrScheduler: aiToolkitParams.lrScheduler,
    optimizerType: aiToolkitParams.optimizerType,
    networkDim: aiToolkitParams.networkDim ?? undefined,
    networkAlpha: aiToolkitParams.networkAlpha ?? undefined,
    noiseOffset: aiToolkitParams.noiseOffset ?? undefined,
    flipAugmentation: aiToolkitParams.flipAugmentation,
    shuffleTokens: aiToolkitParams.shuffleTokens,
    keepTokens: aiToolkitParams.keepTokens,
  };

  if (aiToolkitParams.ecosystem === 'sd1') {
    trainingInput = {
      ...trainingInput,
      model,
      minSnrGamma: aiToolkitParams.minSnrGamma ?? undefined,
    } as Sd1AiToolkitTrainingInput;
  } else if (aiToolkitParams.ecosystem === 'sdxl') {
    trainingInput = {
      ...trainingInput,
      model,
      minSnrGamma: aiToolkitParams.minSnrGamma ?? undefined,
    } as SdxlAiToolkitTrainingInput;
  }

  return {
    $type: 'training',
    metadata: { modelFileId },
    priority,
    retries: constants.maxTrainingRetries,
    input: trainingInput,
  };
};

// Dispatcher to route to the correct training step creator
const createTrainingStep = (
  input: ImageTrainingStepSchema
): ImageResourceTrainingStepTemplate | TrainingStepTemplate => {
  const { engine } = input;

  if (engine === 'ai-toolkit') {
    return createTrainingStep_AiToolkit(input);
  } else {
    return createTrainingStep_Run(input); // Existing function for kohya, rapid, musubi
  }
};

export const createTrainingWorkflow = async ({
  modelVersionId,
  token,
  user,
  currencies,
}: ImageTrainingWorkflowSchema) => {
  if (!env.WEBHOOK_URL) throw throwInternalServerError('Missing webhook URL');
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
           mv.id       "modelVersionId",
           mv."meta" "modelVersionMetadata"
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
  const negativePrompt = modelVersion.trainingDetails.negativePrompt ?? '';
  const isPriority = modelVersion.trainingDetails.highPriority ?? false;
  const fileMetadata = modelVersion.fileMetadata ?? {};
  const trainingDataImagesCount = fileMetadata.numImages ?? 1;
  // const trainingResults = (fileMetadata.trainingResults ?? {}) as TrainingResultsV2;

  if (isInvalidRapid(baseModelType, trainingParams.engine))
    throw throwBadRequestError('Cannot use Rapid Training with a non-flux base model.');

  if (isInvalidAiToolkit(baseModelType, trainingParams.engine))
    throw throwBadRequestError('AI Toolkit training is not supported for this model.');

  const { url: trainingData } = await getGetUrl(modelVersion.trainingUrl);

  // Multi-dataset support for Image Edit training (placeholder)
  // When orchestrator API supports multiple datasets, this section will be expanded
  const trainingType = modelVersion.trainingDetails.type;
  const datasets = modelVersion.trainingDetails.datasets;
  if (trainingType === 'Image Edit' && datasets && datasets.length > 0) {
    // PLACEHOLDER: Future multi-dataset handling
    // For now, Image Edit uses the primary training data file
    // When orchestrator supports multiple files:
    // - Each dataset will be uploaded as a separate zip
    // - Their URLs will be passed to the training step
    // const datasetUrls = await Promise.all(
    //   datasets.map(async (d) => {
    //     if (!d.fileId) return null;
    //     const file = await dbWrite.modelFile.findFirst({ where: { id: d.fileId } });
    //     if (!file) return null;
    //     const { url } = await getGetUrl(file.url);
    //     return { url, label: d.label, count: d.numImages };
    //   })
    // );
    console.log(
      `[Training] Image Edit training with ${datasets.length} dataset(s) - using primary file for now`
    );
  }

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

  // Don't override the engine field in params - it needs to remain as the literal type
  // from the database for the discriminated union to work properly
  const params = trainingParams;

  const runArgs: ImageTrainingStepSchema = {
    model,
    priority,
    trainingData,
    trainingDataImagesCount,
    engine, // This uses the OrchEngineTypes enum
    loraName,
    samplePrompts,
    negativePrompt,
    modelFileId,
    params, // This keeps the literal string type in params.engine
  };

  const stepRun = createTrainingStep(runArgs);

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
      // @ts-ignore - BuzzSpendType is properly supported.
      currencies,
    },
  });

  // Update file and version status immediately after workflow creation
  const now = new Date().toISOString();
  const existingTrainingResults = (fileMetadata.trainingResults ??
    {}) as Partial<TrainingResultsV2>;
  const existingHistory = existingTrainingResults.history ?? [];

  const newTrainingResults: TrainingResultsV2 = {
    ...existingTrainingResults,
    version: 2,
    workflowId: workflow.id ?? 'unk',
    submittedAt: now,
    startedAt: null,
    completedAt: null,
    epochs: existingTrainingResults.epochs ?? [],
    history: [...existingHistory, { time: now, status: TrainingStatus.Submitted }],
    sampleImagesPrompts: samplePrompts,
    transactionData: workflow.transactions?.list ?? [],
  };

  const newMetadata: FileMetadata = {
    ...fileMetadata,
    trainingResults: newTrainingResults,
  };

  await dbWrite.modelFile.update({
    where: { id: modelFileId },
    data: { metadata: newMetadata },
  });

  await dbWrite.modelVersion.update({
    where: { id: modelVersionId },
    data: {
      trainingStatus: TrainingStatus.Submitted,
      meta: {
        ...(modelVersion.modelVersionMetadata ?? {}),
        trainingWorkflowId: workflow.id,
      },
    },
  });

  return workflow;
};

export const createTrainingWhatIfWorkflow = async ({
  token,
  currencies,
  ...input
}: ImageTraininWhatIfWorkflowSchema) => {
  const { model, priority, engine, trainingDataImagesCount, ...trainingParams } = input;

  const params = {
    ...trainingParams,
    engine,
  } as any; // Type assertion needed because whatIf schema is a union

  const runArgs: ImageTrainingStepSchema = {
    model,
    priority,
    engine,
    trainingDataImagesCount,
    params,
    trainingData: 'https://fake',
    loraName: '',
    samplePrompts: ['', '', ''],
    modelFileId: -1,
    negativePrompt: '',
  };

  const stepRun = createTrainingStep(runArgs);

  const workflow = await submitWorkflow({
    token,
    body: {
      steps: [stepRun],
      // @ts-ignore - BuzzSpendType is properly supported.
      currencies,
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
