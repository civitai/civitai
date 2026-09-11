import type {
  ImageResourceTrainingOutput,
  ImageResourceTrainingStep,
  TrainingOutput,
  TrainingStep,
  Workflow,
} from '@civitai/client';
import type { SessionUser } from '~/types/session';
import { upsertModel } from '~/server/services/model.service';
import { upsertModelVersion } from '~/server/services/model-version.service';
import { createFile } from '~/server/services/model-file.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { dbWrite } from '~/server/db/client';
import type { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import type {
  TrainingDetailsBaseModelList,
  TrainingDetailsObj,
} from '~/server/schema/model-version.schema';
import {
  trainingBaseModelTypesAudio,
  trainingBaseModelTypesVideo,
  trainingModelInfo,
  type TrainingBaseModelType,
} from '~/utils/training';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import {
  ModelStatus,
  ModelType,
  ModelUploadType,
  TrainingStatus,
} from '~/shared/utils/prisma/enums';

type TrainingStudioMeta = {
  name?: string;
  trigger?: string;
};

/** The training step's input, read defensively — the client types `input` loosely and a foreign run may
 * carry only some of these. `model` is the AIR (imageResourceTraining path); `ecosystem`/`modelVariant`
 * identify an AI Toolkit base. */
type TrainingStepInputLike = {
  model?: string;
  ecosystem?: string;
  modelVariant?: string;
  epochs?: number;
  steps?: number;
  triggerWord?: string;
  samples?: { prompts?: string[] };
};

function getTrainingStep(workflow: Workflow) {
  const step = workflow.steps?.find((s) => (s as { $type?: string }).$type === 'training') as
    | TrainingStep
    | undefined;
  if (step) return { step, stepType: 'training' as const };
  const legacy = workflow.steps?.find(
    (s) => (s as { $type?: string }).$type === 'imageResourceTraining'
  ) as ImageResourceTrainingStep | undefined;
  if (legacy) return { step: legacy, stepType: 'imageResourceTraining' as const };
  const first = workflow.steps?.[0] as TrainingStep | ImageResourceTrainingStep | undefined;
  if (!first) throw throwBadRequestError('Workflow has no training step');
  const stepType = (first as { $type?: string }).$type;
  if (stepType !== 'training' && stepType !== 'imageResourceTraining')
    throw throwBadRequestError(`Unsupported training step type: ${stepType ?? 'unknown'}`);
  return { step: first, stepType };
}

/**
 * Resolve the workflow's training base model to a real `ModelVersion.baseModel`, its type, and the
 * `trainingDetails.baseModel` key the wizard/orchestrator expect. Prefers the run's exact AIR, then its
 * AI Toolkit ecosystem (+ variant). A base outside `trainingModelInfo` (a custom AIR, a foreign or older
 * run) is unresolvable — throws, so the caller can refuse rather than write a malformed version.
 */
type TrainingModelInfoEntry = (typeof trainingModelInfo)[TrainingDetailsBaseModelList];

export function mapTrainingBaseModelToBaseModel(workflow: Workflow): {
  baseModel: BaseModel;
  trainingBaseModelType: TrainingBaseModelType;
  trainingKey: TrainingDetailsBaseModelList;
  info: TrainingModelInfoEntry;
} {
  const { step } = getTrainingStep(workflow);
  const input = ((step as { input?: TrainingStepInputLike }).input ?? {}) as TrainingStepInputLike;

  const entries = Object.entries(trainingModelInfo) as [
    TrainingDetailsBaseModelList,
    TrainingModelInfoEntry
  ][];

  let match = input.model ? entries.find(([, info]) => info.air === input.model) : undefined;
  if (!match && input.ecosystem) {
    match = entries.find(
      ([, info]) =>
        info.aiToolkit?.ecosystem === input.ecosystem &&
        (input.modelVariant == null || info.aiToolkit?.modelVariant === input.modelVariant)
    );
  }
  if (!match && input.ecosystem)
    match = entries.find(([, info]) => info.aiToolkit?.ecosystem === input.ecosystem);

  if (!match)
    throw throwBadRequestError(
      'This training run uses a base model that can no longer be published from Training Studio.'
    );

  const [trainingKey, info] = match;
  return {
    baseModel: info.baseModel,
    trainingBaseModelType: info.type,
    trainingKey,
    info,
  };
}

function toIso(value?: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Map a training workflow's epochs into `TrainingResultsV2` — the shape the wizard's step-4 file picker
 * and the generator's epoch resolver both read off `metadata.trainingResults`. Mirrors
 * `deriveTrainingWorkflowState`'s field reads for the two step types, but does NOT require
 * `step.metadata.modelFileId` (training-studio runs are created without one).
 */
export function mapWorkflowToTrainingResultsV2(workflow: Workflow): TrainingResultsV2 {
  const { step, stepType } = getTrainingStep(workflow);
  const submittedAt = toIso(workflow.createdAt) ?? new Date().toISOString();
  const startedAt = toIso((step as { startedAt?: string | null }).startedAt);
  const completedAt = toIso((step as { completedAt?: string | null }).completedAt);

  let epochs: TrainingResultsV2['epochs'] = [];
  let sampleImagesPrompts: string[] = [];

  if (stepType === 'training') {
    const trainingStep = step as TrainingStep;
    const output = trainingStep.output as TrainingOutput | undefined;
    sampleImagesPrompts = trainingStep.input?.samples?.prompts ?? [];
    epochs = (output?.epochs ?? [])
      .filter((epoch) => epoch.model?.available !== false)
      .map((epoch) => ({
        epochNumber: epoch.epochNumber ?? -1,
        modelUrl: epoch.model?.url ?? '',
        modelSize: 0,
        sampleImages: (epoch.samples ?? [])
          .map((sample) => sample.url ?? '')
          .filter((url) => url.length > 0),
      }));
  } else {
    const output = (step as ImageResourceTrainingStep).output as
      | ImageResourceTrainingOutput
      | undefined;
    sampleImagesPrompts = output?.sampleImagesPrompts ?? [];
    epochs = (output?.epochs ?? []).map((epoch) => ({
      epochNumber: epoch.epochNumber ?? -1,
      modelUrl: epoch.blobUrl ?? '',
      modelSize: epoch.blobSize ?? 0,
      sampleImages: (epoch.sampleImages ?? []).filter((url) => url.length > 0),
    }));
  }

  return {
    version: 2,
    workflowId: workflow.id ?? 'unk',
    submittedAt,
    startedAt,
    completedAt,
    transactionData: [],
    history: [],
    epochs,
    sampleImagesPrompts,
  };
}

/**
 * Turn a completed Training Studio orchestrator workflow into a Draft Trained Model + v1 ModelVersion +
 * Training-Data ModelFile, so the user can drop into the main app's publish wizard (step 4) or generate
 * off the draft. Training Studio trains orchestrator-only (no `ModelVersion` exists), so this reconstructs
 * the minimal chain the wizard/generator require — it does NOT move assets, create a 'Model' file, or
 * publish; the wizard does those on user action.
 *
 * Idempotent per workflow: the first call stamps `meta.trainingStudioWorkflowId`, and later calls for the
 * same workflow return the existing ids instead of creating a duplicate.
 */
export async function createDraftModelFromWorkflow({
  user,
  workflow,
  selectedEpochNumber,
  name,
}: {
  user: SessionUser;
  workflow: Workflow;
  selectedEpochNumber: number;
  name?: string;
}): Promise<{ modelId: number; modelVersionId: number }> {
  if (!workflow.id) throw throwBadRequestError('Workflow is missing an id');

  const existing = await dbWrite.model.findFirst({
    where: {
      userId: user.id,
      uploadType: ModelUploadType.Trained,
      meta: { path: ['trainingStudioWorkflowId'], equals: workflow.id },
    },
    select: {
      id: true,
      modelVersions: { select: { id: true }, take: 1, orderBy: { index: 'asc' } },
    },
  });
  if (existing?.modelVersions[0])
    return { modelId: existing.id, modelVersionId: existing.modelVersions[0].id };

  const {
    baseModel,
    trainingBaseModelType,
    trainingKey,
    info: trainingInfo,
  } = mapTrainingBaseModelToBaseModel(workflow);
  const { step } = getTrainingStep(workflow);
  const input = ((step as { input?: TrainingStepInputLike }).input ?? {}) as TrainingStepInputLike;
  const meta = (workflow.metadata ?? {}) as TrainingStudioMeta;

  const trigger = meta.trigger || input.triggerWord || undefined;
  const modelName =
    name?.trim() ||
    meta.name?.trim() ||
    workflow.tags?.find((tag) => tag.startsWith('name:'))?.slice('name:'.length) ||
    trigger ||
    'Trained LoRA';

  const trainingResults = mapWorkflowToTrainingResultsV2(workflow);
  const selectedEpoch =
    trainingResults.epochs.find((epoch) => epoch.epochNumber === selectedEpochNumber) ??
    trainingResults.epochs.at(-1);
  if (!selectedEpoch?.modelUrl)
    throw throwBadRequestError('This training run has no downloadable checkpoint to publish.');

  // Best-effort params so the version's trainingDetails is complete for the wizard. The load-bearing
  // fields are `baseModel`/`type`; the rest are defaulted (the run's real hyperparameters live on the
  // orchestrator workflow, which stays the source of truth) with the length knobs carried from the step.
  const mediaType = (trainingBaseModelTypesVideo as readonly string[]).includes(
    trainingBaseModelType
  )
    ? 'video'
    : (trainingBaseModelTypesAudio as readonly string[]).includes(trainingBaseModelType)
    ? 'audio'
    : 'image';

  const trainingDetails: TrainingDetailsObj = {
    type: 'Character',
    mediaType,
    baseModel: trainingKey,
    baseModelType: trainingBaseModelType,
    params: {
      engine: 'ai-toolkit',
      ecosystem: input.ecosystem ?? trainingInfo.aiToolkit?.ecosystem ?? '',
      ...(input.modelVariant && { modelVariant: input.modelVariant }),
      ...(typeof input.steps === 'number' && { steps: input.steps }),
      ...(typeof input.epochs === 'number' && { epochs: input.epochs }),
      resolution: null,
      lr: 0,
      textEncoderLr: null,
      trainTextEncoder: false,
      lrScheduler: 'constant',
      optimizerType: 'adamw',
      networkDim: null,
      networkAlpha: null,
      noiseOffset: null,
      minSnrGamma: null,
      flipAugmentation: false,
      shuffleTokens: false,
      keepTokens: 0,
    },
    samplePrompts: input.samples?.prompts ?? [],
  };

  const model = await upsertModel({
    name: modelName,
    type: ModelType.LORA,
    uploadType: ModelUploadType.Trained,
    status: ModelStatus.Draft,
    userId: user.id,
    nsfw: false,
    poi: false,
    minor: false,
    meta: { trainingStudioWorkflowId: workflow.id } as Record<string, unknown>,
  });
  if (!model) throw throwBadRequestError('Could not create the model');

  const modelVersion = await upsertModelVersion({
    modelId: model.id,
    name: 'v1',
    baseModel,
    uploadType: ModelUploadType.Trained,
    status: ModelStatus.Draft,
    trainedWords: trigger ? [trigger] : [],
    trainingStatus: TrainingStatus.InReview,
    trainingDetails,
  });

  await createFile({
    name: `${modelVersion.id}_training_data.zip`,
    url: selectedEpoch.modelUrl,
    sizeKB: 0,
    type: 'Training Data',
    modelVersionId: modelVersion.id,
    metadata: {
      trainingResults,
      selectedEpochUrl: selectedEpoch.modelUrl,
    },
    userId: user.id,
    select: { id: true },
  });

  return { modelId: model.id, modelVersionId: modelVersion.id };
}
