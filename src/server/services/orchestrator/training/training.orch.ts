import type { YuE2SampleOverride, YuE2AiToolkitTrainingInput } from '@civitai/orchestration-client';
import { formatYue2SamplePrompt } from '@civitai/shared/training-audio';
import { yue2SampleOverrideSchema } from '~/server/schema/model-version.schema';
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
  AnimaAiToolkitTrainingInput,
} from '@civitai/client';
import {
  isSafeTensorFormat,
  NON_SAFETENSOR_CUSTOM_MODEL_MESSAGE,
} from '@civitai/shared/training-custom-model';
import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import {
  buildCentralErrorLog,
  classifyErrorFault,
  logToAxiom,
  markServerFaultLogged,
} from '~/server/logging/client';
import type { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import { resolveEpochOffset } from '~/shared/utils/training-epochs';
import type {
  AiToolkitTrainingParams,
  ImageTrainingStepSchema,
  ImageTrainingWorkflowSchema,
  ImageTraininWhatIfWorkflowSchema,
} from '~/server/schema/orchestrator/training.schema';
import { TRAINING_WORKFLOW_TAG } from '~/server/services/orchestrator/training/workflow-state';
import { assertWorkflowOwner } from '~/server/services/orchestrator/assert-workflow-owner';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import type { TrainingRequest } from '~/server/services/training.service';
import { getTrainingServiceStatus } from '~/server/services/training.service';
import { throwBadRequestError, throwInternalServerError } from '~/server/utils/errorHandling';
import { TrainingStatus } from '~/shared/utils/prisma/enums';
import { getGetUrl, getB2S3Client, isB2Url } from '~/utils/s3-utils';
import { parseAIRSafe } from '~/utils/string-helpers';
import {
  getTrainingFields,
  isInvalidRapid,
  isInvalidAiToolkit,
  isAiToolkitEnabled,
  isAudioTrainingBaseType,
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

  return isSafeTensorFormat(data?.fmt);
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
        message: NON_SAFETENSOR_CUSTOM_MODEL_MESSAGE,
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

/**
 * The dataset an ai-toolkit step trains on: a zip (the training form's upload) or a
 * list of individually uploaded orchestrator blobs with per-item captions (the
 * Training Studio's shape, and the App Blocks `kind:'training'` shape).
 */
export type AiToolkitTrainingData =
  | ZipTrainingData
  | { type: 'blobs'; items: Array<{ air: string; caption: string }> };

export type AiToolkitTrainingStepInput = {
  model: string;
  priority: ImageTrainingStepSchema['priority'];
  triggerWord: string;
  trainingData: AiToolkitTrainingData;
  samplePrompts: string[];
  samplesOverrides?: ImageTrainingStepSchema['samplesOverrides'];
  params: AiToolkitTrainingParams;
  /** Step metadata. Omitted from the step entirely when absent. */
  metadata?: Record<string, unknown>;
};

/**
 * Build the ai-toolkit `training` step. PURE: no I/O, no clock, no randomness, so
 * a whatif quote and the real submit built from the same input describe the same
 * work. Shared by the training form (zip dataset, via `createTrainingStep_AiToolkit`)
 * and the App Blocks `kind:'training'` bridge (blob dataset).
 *
 * Stamps no `timeout` and no `name`; callers add them.
 */
export const buildAiToolkitTrainingStep = (
  input: AiToolkitTrainingStepInput
): TrainingStepTemplate => {
  const {
    model,
    priority,
    triggerWord,
    trainingData,
    samplePrompts,
    samplesOverrides,
    params: aiToolkitParams,
    metadata,
  } = input;

  let trainingInput: AiToolkitTrainingInput | YuE2AiToolkitTrainingInput = {
    engine: 'ai-toolkit',
    ecosystem: aiToolkitParams.ecosystem,

    ...(aiToolkitParams.modelVariant && { modelVariant: aiToolkitParams.modelVariant }),
    trainingData,
    samples: {
      prompts:
        aiToolkitParams.ecosystem === 'yue2'
          ? samplePrompts.map(formatYue2SamplePrompt)
          : samplePrompts,
      ...(aiToolkitParams.ecosystem !== 'yue2' && {
        cfgScale: aiToolkitParams.sampleCfgScale ?? undefined,
      }),
      strength: aiToolkitParams.sampleStrength ?? undefined,
    },
    // Steps-based pricing: `steps` is the primary length knob and drives pricing;
    // `epochs` is the saved-checkpoint count. `numberOfRepeats` is deprecated and no
    // longer sent. Sending `epochs` without `steps` keeps the legacy flat pricing.
    steps: aiToolkitParams.steps ?? undefined,
    epochs: aiToolkitParams.epochs ?? undefined,
    batchSize: aiToolkitParams.batchSize ?? undefined,
    continueFrom: aiToolkitParams.continueFrom ?? undefined,
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
    triggerWord,
    // `storageBuzzPerEpoch`, `defaultSteps`, `usesStepPricing`, and `maxBatchSize` are
    // server-computed readonly outputs on the SDK type — cast through `unknown` since we
    // can't (and shouldn't) supply them on the request.
  } as unknown as AiToolkitTrainingInput & { triggerWord: string };

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
  } else if (aiToolkitParams.ecosystem === 'anima') {
    // The civitai Anima AIR is the sample-image diffusion model, not the trainer base; sending it
    // here bills its per-image license fee once per epoch checkpoint.
    if (model !== trainingModelInfo.anima.air) {
      trainingInput = {
        ...trainingInput,
        model,
      } as AnimaAiToolkitTrainingInput;
    }
  }

  if (
    samplesOverrides &&
    samplesOverrides.length > 0 &&
    (aiToolkitParams.ecosystem === 'ace_step_15' || aiToolkitParams.ecosystem === 'ace_step_15_xl')
  ) {
    (
      trainingInput as AiToolkitTrainingInput & {
        samplesOverrides?: Array<Record<string, unknown>>;
      }
    ).samplesOverrides = samplesOverrides as Array<Record<string, unknown>>;
  }

  if (aiToolkitParams.ecosystem === 'yue2' && samplesOverrides?.length) {
    const overrides: YuE2SampleOverride[] = samplesOverrides.map((override) =>
      yue2SampleOverrideSchema.parse(override)
    );
    trainingInput = { ...trainingInput, ecosystem: 'yue2', samplesOverrides: overrides };
  }

  return {
    $type: 'training',
    ...(metadata ? { metadata } : {}),
    priority,
    retries: constants.maxTrainingRetries,
    input: trainingInput,
  };
};

// The training form's ai-toolkit step: a zip dataset plus the version's ModelFile id.
const createTrainingStep_AiToolkit = (input: ImageTrainingStepSchema): TrainingStepTemplate => {
  const {
    model,
    priority,
    triggerWord,
    trainingData,
    trainingDataImagesCount,
    samplePrompts,
    samplesOverrides,
    modelFileId,
    params,
  } = input;

  return buildAiToolkitTrainingStep({
    model,
    priority,
    triggerWord,
    trainingData: {
      type: 'zip',
      sourceUrl: trainingData,
      count: trainingDataImagesCount,
    },
    samplePrompts,
    samplesOverrides,
    // Params are already in AI Toolkit format from the database
    params: params as AiToolkitTrainingParams,
    metadata: { modelFileId },
  });
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

const ORCHESTRATOR_REJECTED_CODES = new Set<TRPCError['code']>([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'TOO_MANY_REQUESTS',
]);

export const createTrainingWorkflow = async ({
  modelVersionId,
  token,
  user,
  features,
  domain,
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
           mv."trainedWords",
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
    ORDER BY mf."sizeKB" DESC, mf.id DESC
    LIMIT 1
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
  const samplesOverrides = modelVersion.trainingDetails.samplesOverrides;
  const negativePrompt = modelVersion.trainingDetails.negativePrompt ?? '';
  const isPriority = modelVersion.trainingDetails.highPriority ?? false;
  const fileMetadata = modelVersion.fileMetadata ?? {};
  const trainingDataImagesCount = fileMetadata.numImages ?? 1;

  // Content prepared under red's permissive policy (captions/images live in the training zip and
  // aren't re-checked here) must be paid for and run on red, not laundered onto green by switching
  // domains at the final step. Legacy datasets predate the stamp and fall through to post-run
  // moderation. See createFileHandler for where uploadDomain is set.
  if (domain === 'green' && fileMetadata.uploadDomain === 'red') {
    throw throwBadRequestError(
      'This training dataset was prepared on civitai.red and must be submitted there. Switch back to civitai.red to start this training.'
    );
  }
  // const trainingResults = (fileMetadata.trainingResults ?? {}) as TrainingResultsV2;

  if (isInvalidRapid(baseModelType, trainingParams.engine))
    throw throwBadRequestError('Cannot use Rapid Training with a non-flux base model.');

  if (isInvalidAiToolkit(baseModelType, trainingParams.engine))
    throw throwBadRequestError('AI Toolkit training is not supported for this model.');

  if (trainingParams.engine === 'ai-toolkit' && !isAiToolkitEnabled(baseModelType, features))
    throw throwBadRequestError('AI Toolkit training is not currently enabled for this base model.');

  // Audio base types are marked `isAiToolkitMandatory`, so the check above
  // short-circuits to true regardless of feature flags. Enforce the rollout
  // flag here so API callers can't submit ACE-Step training when the
  // `audioTraining` flag is off.
  if (isAudioTrainingBaseType(baseModelType) && !features.audioTraining)
    throw throwBadRequestError('Audio training is not currently enabled.');

  const { url: trainingData } = isB2Url(modelVersion.trainingUrl)
    ? await getGetUrl(modelVersion.trainingUrl, { s3: getB2S3Client() })
    : await getGetUrl(modelVersion.trainingUrl);

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
  const triggerWord = modelVersion.trainedWords?.[0] ?? '';
  const modelFileId = modelVersion.fileId;

  // Don't override the engine field in params - it needs to remain as the literal type
  // from the database for the discriminated union to work properly.
  // Note: `continueFrom` (continue-training) is an orchestrator-sourced AIR referencing
  // the epoch's LoRA — same form generation uses — and passes through as-is.
  let params = trainingParams;

  // The trainingStepsPricing flag is authoritative on the submission path: when it's off,
  // strip the steps-pricing fields even if they made it into the stored params (direct API
  // callers, or a version created while the user was flagged in). An epochs-only payload
  // keeps the legacy flat per-epoch pricing.
  if (trainingParams.engine === 'ai-toolkit') {
    if (!features.trainingStepsPricing) {
      const { steps, batchSize, sampleCfgScale, sampleStrength, continueFrom, ...legacyParams } =
        trainingParams;
      params = legacyParams;
    }
  } else {
    // continueFrom / sample params / saveEvery are AI Toolkit-only. The kohya-shaped params
    // schema tolerates them (it doubles as the UI run state), but they must never reach the
    // kohya/rapid/musubi dispatch, which spreads params straight into the payload.
    const { continueFrom, sampleCfgScale, sampleStrength, saveEvery, ...engineParams } =
      trainingParams;
    params = engineParams;
  }

  const runArgs: ImageTrainingStepSchema = {
    model,
    priority,
    trainingData,
    trainingDataImagesCount,
    engine, // This uses the OrchEngineTypes enum
    loraName,
    triggerWord,
    samplePrompts,
    samplesOverrides,
    negativePrompt,
    modelFileId,
    params, // This keeps the literal string type in params.engine
  };

  const stepRun = createTrainingStep(runArgs);

  // `type` and `baseModel` are fixed at submit, so tagging them here is what makes those two
  // filters answerable orchestrator-side later — tags are the only server-side filter
  // `queryWorkflows` offers. Nothing reads them yet.
  const trainingType = modelVersion.trainingDetails.type;

  // Every submitWorkflow call is its own charged workflow, and the version keeps only the last
  // workflowId, so a repeat submit strands a paid run. Claim the version atomically first.
  // NULL is claimable because the extra runs of a multi-run submit are created without a status.
  const { count: claimed } = await dbWrite.modelVersion.updateMany({
    where: {
      id: modelVersionId,
      OR: [{ trainingStatus: null }, { trainingStatus: TrainingStatus.Pending }],
    },
    data: { trainingStatus: TrainingStatus.Submitted },
  });
  if (claimed === 0) throw throwBadRequestError('This model was already submitted for training.');

  let workflow: Awaited<ReturnType<typeof submitWorkflow>>;
  try {
    workflow = await submitWorkflow({
      token,
      body: {
        tags: [
          TRAINING_WORKFLOW_TAG,
          `modelVersion:${modelVersionId}`,
          `baseModel:${baseModel}`,
          ...(trainingType ? [`trainingType:${trainingType}`] : []),
        ],
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
  } catch (e) {
    // Only a 4xx proves no workflow was created. After a timeout or 5xx one may have been, and
    // releasing would let a retry charge a second run: a stuck version is the cheaper failure.
    if (e instanceof TRPCError && ORCHESTRATOR_REJECTED_CODES.has(e.code)) {
      await dbWrite.modelVersion.updateMany({
        where: { id: modelVersionId, trainingStatus: TrainingStatus.Submitted },
        data: { trainingStatus: TrainingStatus.Pending },
      });
    }
    throw e;
  }

  await assertWorkflowOwner(workflow, userId, token);

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
    epochOffset: resolveEpochOffset(
      existingTrainingResults.epochOffset,
      modelVersion.trainingDetails.continueFromEpoch?.epochNumber
    ),
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
  userId,
  ...input
}: ImageTraininWhatIfWorkflowSchema & { userId?: number }) => {
  const { model, priority, engine, trainingDataImagesCount, samplePrompts, ...trainingParams } =
    input;

  const params = {
    ...trainingParams,
    engine,
  } as any; // Type assertion needed because whatIf schema is a union

  // Per-resource license fees are only priced when the workflow generates
  // samples, so the whatif must always carry non-empty prompts or the estimate
  // silently drops the fee. Keep any real prompts the client sent and backfill
  // empties with a placeholder so the fee is always reflected.
  const whatIfSamplePrompts = (samplePrompts?.length ? samplePrompts : ['', '', '']).map((p) =>
    p && p.trim().length > 0 ? p : 'sample prompt'
  );

  const runArgs: ImageTrainingStepSchema = {
    model,
    priority,
    engine,
    trainingDataImagesCount,
    params,
    trainingData: 'https://fake',
    loraName: '',
    triggerWord: '',
    samplePrompts: whatIfSamplePrompts,
    samplesOverrides: 'samplesOverrides' in input ? input.samplesOverrides : undefined,
    modelFileId: -1,
    negativePrompt: '',
  };

  const whatIfLogData = {
    userId,
    engine,
    ecosystem: 'ecosystem' in params ? params.ecosystem : undefined,
    modelVariant: 'modelVariant' in params ? params.modelVariant : undefined,
    model,
    trainingDataImagesCount,
  };

  const stepRun = createTrainingStep(runArgs);

  let workflow: Awaited<ReturnType<typeof submitWorkflow>>;
  try {
    workflow = await submitWorkflow({
      token,
      body: {
        steps: [stepRun],
        // @ts-ignore - BuzzSpendType is properly supported.
        currencies,
      },
      query: { whatif: true },
    });
  } catch (e) {
    // This query re-fires on a 100ms debounce over every param, so logging a rejected settings
    // combination (4xx) at error severity would be a keystroke storm on the error board.
    logToAxiom(
      {
        name: 'training-whatif',
        ...buildCentralErrorLog(e),
        data: whatIfLogData,
      },
      'webhooks'
    ).catch();
    if (classifyErrorFault(e) === 'server') markServerFaultLogged(e);
    throw e;
  }

  const cost = workflow.cost?.total;
  // Per-resource licensing fees (keyed by resource AIR) are already included in
  // `cost.total`; surface their sum so the UI can break out the license fee.
  const licenseFee = Object.values(workflow.cost?.fees ?? {}).reduce((sum, fee) => sum + fee, 0);

  // `0` stays out of this guard: a zero estimate is spendable, and TrainingSubmit gates on the same
  // `!isDefined(cost) || cost < 0`. Widening one side alone logs a cost the UI is charging.
  if (cost == null || cost < 0) {
    logToAxiom(
      {
        name: 'training-whatif',
        type: 'error',
        message: 'Orchestrator returned an unusable cost',
        data: { ...whatIfLogData, cost },
      },
      'webhooks'
    ).catch();
  }

  const _step = workflow.steps?.[0] as ImageResourceTrainingStep | undefined;
  // console.dir(_step);
  const precedingJobs = _step?.queuePosition?.precedingJobs;
  const eta = _step?.output?.eta;

  return { cost, licenseFee, precedingJobs, eta };
};
