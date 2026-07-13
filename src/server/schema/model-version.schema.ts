import { v4 as uuidv4 } from 'uuid';
import * as z from 'zod';
import {
  MAX_DONATION_GOAL,
  MIN_DONATION_GOAL,
} from '~/components/Model/ModelVersions/model-version.utils';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { constants } from '~/server/common/constants';
import { infiniteQuerySchema } from '~/server/schema/base.schema';
import { imageSchema } from '~/server/schema/image.schema';
import { modelFileSchema } from '~/server/schema/model-file.schema';
import type { ModelMeta } from '~/server/schema/model.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import {
  LicensingFeeSettlementCurrency,
  LicensingFeeType,
  ModelStatus,
  ModelType,
  ModelUploadType,
  ModelUsageControl,
  ModelVersionMonetizationType,
  ModelVersionSponsorshipSettingsType,
  TrainingStatus,
} from '~/shared/utils/prisma/enums';
import { isAir } from '~/utils/string-helpers';
import {
  engineTypes,
  loraTypes,
  lrSchedulerTypes,
  optimizerTypes,
  trainingBaseModelType,
} from '~/utils/training';

export type QueryModelVersionSchema = z.infer<typeof queryModelVersionsSchema>;
export const queryModelVersionsSchema = infiniteQuerySchema.extend({
  trainingStatus: z.enum(TrainingStatus).optional(),
  // uploadType: z.enum(ModelUploadType).optional(),
});

export type RecipeModelInput = z.infer<typeof recipeModelSchema>;
export const recipeModelSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  name: z.string(),
  type: z.enum(['version', 'result', 'unknown']),
});

export type RecipeInput = z.infer<typeof recipeSchema>;
export const recipeSchema = z.object({
  id: z.string().default(uuidv4()),
  type: z.enum(['sum', 'diff']),
  modelA: recipeModelSchema,
  modelB: recipeModelSchema,
  modelC: recipeModelSchema.optional(),
  multiplier: z.number(),
});

const trainingDetailsBaseModelCustom = z
  .string()
  .refine((value) => /^civitai:\d+@\d+$/.test(value ?? '') || isAir(value ?? ''));
export type TrainingDetailsBaseModelCustom = z.infer<typeof trainingDetailsBaseModelCustom>;

export const trainingDetailsBaseModels15 = ['sd_1_5', 'anime', 'semi', 'realistic'] as const;
export const trainingDetailsBaseModelsXL = ['sdxl', 'pony', 'illustrious'] as const;
// export const trainingDetailsBaseModels35 = ['sd3_medium', 'sd3_large'] as const;
export const trainingDetailsBaseModelsFlux = ['flux_dev'] as const;
export const trainingDetailsBaseModelsFlux2 = ['flux2_dev'] as const;
// export const trainingDetailsBaseModelsFlux2Edit = ['flux2_dev_edit'] as const; // Disabled for now
export const trainingDetailsBaseModelsHunyuan = ['hy_720_fp8'] as const;
export const trainingDetailsBaseModelsWan = [
  'wan_2_1_i2v_14b_720p',
  'wan_2_1_t2v_14b',
  'wan_2_2_t2v_a14b',
] as const;
export const trainingDetailsBaseModelsChroma = ['chroma'] as const;
export const trainingDetailsBaseModelsQwen = ['qwen_image'] as const;
export const trainingDetailsBaseModelsZImage = ['zimageturbo', 'zimagebase'] as const;
export const trainingDetailsBaseModelsFlux2Klein = ['flux2klein_4b', 'flux2klein_9b'] as const;
export const trainingDetailsBaseModelsLtx2 = ['ltx2'] as const;
export const trainingDetailsBaseModelsLtx23 = ['ltx23'] as const;
export const trainingDetailsBaseModelsErnie = ['ernie'] as const;
export const trainingDetailsBaseModelsHiDreamO1 = ['hidream_o1'] as const;
export const trainingDetailsBaseModelsAnima = ['anima'] as const;
export const trainingDetailsBaseModelsBoogu = ['boogu'] as const;
export const trainingDetailsBaseModelsKrea2 = ['krea2'] as const;
export const trainingDetailsBaseModelsAcestep15 = ['acestep_15'] as const;
export const trainingDetailsBaseModelsAcestep15Xl = [
  'acestep_15_xl_base',
  'acestep_15_xl_sft',
] as const;

const trainingDetailsBaseModelsImage = [
  ...trainingDetailsBaseModels15,
  ...trainingDetailsBaseModelsXL,
  // ...trainingDetailsBaseModels35,
  ...trainingDetailsBaseModelsFlux,
  ...trainingDetailsBaseModelsFlux2,
  ...trainingDetailsBaseModelsFlux2Klein,
  ...trainingDetailsBaseModelsChroma,
  ...trainingDetailsBaseModelsQwen,
  ...trainingDetailsBaseModelsZImage,
  ...trainingDetailsBaseModelsErnie,
  ...trainingDetailsBaseModelsHiDreamO1,
  ...trainingDetailsBaseModelsAnima,
  ...trainingDetailsBaseModelsBoogu,
  ...trainingDetailsBaseModelsKrea2,
] as const;
const trainingDetailsBaseModelsVideo = [
  ...trainingDetailsBaseModelsHunyuan,
  ...trainingDetailsBaseModelsWan,
  ...trainingDetailsBaseModelsLtx2,
  ...trainingDetailsBaseModelsLtx23,
] as const;
const trainingDetailsBaseModelsAudio = [
  ...trainingDetailsBaseModelsAcestep15,
  ...trainingDetailsBaseModelsAcestep15Xl,
] as const;

const trainingDetailsBaseModels = [
  ...trainingDetailsBaseModelsImage,
  ...trainingDetailsBaseModelsVideo,
  ...trainingDetailsBaseModelsAudio,
] as const;

export type TrainingDetailsBaseModelList = (typeof trainingDetailsBaseModels)[number];
export type TrainingDetailsBaseModel =
  | TrainingDetailsBaseModelList
  | TrainingDetailsBaseModelCustom;

export const baseModelToTraningDetailsBaseModelMap: Partial<
  Record<BaseModel, TrainingDetailsBaseModelList>
> = {
  'Wan Video 14B i2v 720p': 'wan_2_1_i2v_14b_720p',
  'Wan Video 14B i2v 480p': 'wan_2_1_i2v_14b_720p',
  'Wan Video 14B t2v': 'wan_2_1_t2v_14b',
  'Wan Video 2.2 T2V-A14B': 'wan_2_2_t2v_a14b',
};

// Kohya-style training parameters (used by frontend and as legacy format)
export const trainingDetailsParams = z.object({
  unetLR: z.number(),
  textEncoderLR: z.number(),
  optimizerType: z.enum(optimizerTypes),
  networkDim: z.number(),
  networkAlpha: z.number(),
  lrScheduler: z.enum(lrSchedulerTypes),
  maxTrainEpochs: z.number(),
  numRepeats: z.number(),
  resolution: z.number(),
  loraType: z.enum(loraTypes),
  enableBucket: z.boolean(),
  keepTokens: z.number(),
  clipSkip: z.number().optional(),
  flipAugmentation: z.boolean().optional(),
  noiseOffset: z.number().optional(),
  lrSchedulerNumCycles: z.number(),
  trainBatchSize: z.number(),
  minSnrGamma: z.number(),
  optimizerArgs: z.string().optional(),
  shuffleCaption: z.boolean(),
  targetSteps: z.number(),
  engine: z.enum(engineTypes).optional().default('kohya'),
  // Steps-based pricing (AI Toolkit) — sample generation + continue-training inputs.
  // Stored on the UI/Kohya-shaped run params so they round-trip through the store,
  // then mapped into the AI Toolkit payload at submit/whatif time.
  sampleCfgScale: z.number().optional(),
  sampleStrength: z.number().optional(),
  /** AIR of a previously-trained LoRA to continue training from ("train further"). */
  continueFrom: z.string().optional(),
  // "Save every N steps" — the UI knob that derives `maxTrainEpochs` (saved checkpoints)
  // as round(targetSteps / saveEvery). UI-only; we send the derived `epochs`, never this.
  saveEvery: z.number().int().min(1).optional(),
});
export type TrainingDetailsParams = z.infer<typeof trainingDetailsParams>;

// AI Toolkit training parameters (alternate format for database storage)
const aiToolkitTrainingDetailsParams = z.object({
  engine: z.literal('ai-toolkit'),
  ecosystem: z.string(),
  modelVariant: z.string().optional(),
  // Steps-based pricing: `steps` is the primary length knob (drives pricing);
  // `epochs` is the number of saved checkpoints. `epochs`-only (no `steps`) keeps
  // the legacy flat per-epoch pricing for back-compat.
  epochs: z.number().int().min(1).optional(),
  steps: z.number().int().min(1).optional(),
  batchSize: z.number().int().min(1).optional(),
  sampleCfgScale: z.number().optional(),
  sampleStrength: z.number().optional(),
  /** AIR of a previously-trained LoRA to continue training from. */
  continueFrom: z.string().optional(),
  resolution: z.number().nullable(),
  lr: z.number(),
  textEncoderLr: z.number().nullable(),
  trainTextEncoder: z.boolean(),
  lrScheduler: z.enum(['constant', 'constant_with_warmup', 'cosine', 'linear', 'step']),
  optimizerType: z.enum([
    'adamw',
    'adamw8bit',
    'adam8bit',
    'lion',
    'lion8bit',
    'adafactor',
    'adagrad',
    'prodigy',
    'prodigy8bit',
    'automagic',
  ]),
  networkDim: z.number().nullable(),
  networkAlpha: z.number().nullable(),
  noiseOffset: z.number().nullable(),
  minSnrGamma: z.number().nullable(),
  flipAugmentation: z.boolean(),
  shuffleTokens: z.boolean(),
  keepTokens: z.number(),
  numRepeats: z.number().optional(),
  maxTrainEpochs: z.number().nullable().optional(),
});

// Union type for database storage - supports both formats
export const trainingDetailsParamsUnion = z.discriminatedUnion('engine', [
  trainingDetailsParams.extend({
    engine: z.enum(['kohya', 'rapid', 'flux2-dev', 'flux2-dev-edit', 'musubi'] as const),
  }),
  aiToolkitTrainingDetailsParams,
]);
export type TrainingDetailsParamsUnion = z.infer<typeof trainingDetailsParamsUnion>;

// Per-prompt overrides for ACE-Step audio training samples. Index-aligned with
// `samplePrompts`. Fields the SDK accepts as nullable are stored optional here;
// we coerce to null in the orchestrator dispatch as needed. Bounds mirror the UI
// inputs in TrainingSubmitAdvancedSettings so API callers and persisted data
// can't bypass them.
export const audioSampleOverrideSchema = z.object({
  lyrics: z.string().max(10000).optional(),
  duration: z.number().min(1).max(360).optional(),
  bpm: z.number().min(20).max(300).optional(),
  timeSignature: z.string().max(16).optional(),
  language: z.string().max(64).optional(),
  key: z.string().max(64).optional(),
  instrumentalWeight: z.number().min(0).max(1).optional(),
  vocalWeight: z.number().min(0).max(1).optional(),
  steps: z.number().int().min(1).max(200).optional(),
  cfg: z.number().min(0).max(20).optional(),
});
export type AudioSampleOverrideSchema = z.infer<typeof audioSampleOverrideSchema>;

export type TrainingDetailsObj = z.infer<typeof trainingDetailsObj>;
export const trainingDetailsObj = z.object({
  baseModel: z
    .union([z.enum(trainingDetailsBaseModels), trainingDetailsBaseModelCustom])
    .optional(), // nb: this is not optional when submitting
  baseModelType: z.enum(trainingBaseModelType).optional(),
  type: z.enum(constants.trainingModelTypes),
  mediaType: z.enum(constants.trainingMediaTypes).optional().default('image'),
  // triggerWord: z.string().optional(),
  params: trainingDetailsParamsUnion.optional(), // Support both Kohya and AI Toolkit formats
  samplePrompts: z.array(z.string()).optional(),
  samplesOverrides: z.array(audioSampleOverrideSchema).optional(),
  negativePrompt: z.string().optional(),
  staging: z.boolean().optional(),
  highPriority: z.boolean().optional(),
  // "Train Further": which epoch this version continues training from. The orchestrator
  // payload only needs params.continueFrom (an orchestrator-sourced AIR for the epoch's
  // LoRA, same as generation uses); this object exists so the UI can clearly label the
  // source epoch, and it survives reloads (the in-memory training store does not).
  continueFromEpoch: z
    .object({
      air: z.string(),
      epochNumber: z.number(),
      sourceModelVersionId: z.number(),
      sourceVersionName: z.string().optional(),
    })
    .optional(),
});

export const modelVersionUpsertSchema = z.object({
  id: z.coerce.number().optional(),
  name: z.string().min(1, 'Name cannot be empty.'),
  baseModel: z.string(),
  baseModelType: z.enum(constants.baseModelTypes).nullish(),
  description: getSanitizedStringSchema({
    allowedTags: ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br', 'ul', 'ol', 'li', 'code', 'pre'],
    stripEmpty: true,
  }).nullish(),
  steps: z.coerce.number().min(0).nullish(),
  epochs: z.coerce.number().min(0).max(100000).nullish(),
  images: z
    .array(imageSchema)
    .min(1, 'At least one example image must be uploaded')
    .max(20, 'You can only upload up to 20 images'),
  trainedWords: z.array(z.string()),
  trainingStatus: z.enum(TrainingStatus).optional(),
  trainingDetails: trainingDetailsObj.optional(),
  files: z.array(modelFileSchema),
  // recipe: z.array(recipeSchema).optional(),
});

export type RecommendedSettingsSchema = z.infer<typeof recommendedSettingsSchema>;
export const recommendedSettingsSchema = z.object({
  minStrength: z.coerce.number().nullish(),
  maxStrength: z.coerce.number().nullish(),
  strength: z.coerce.number().nullish(),
});

export const linkedComponentSettingsSchema = z.object({
  isLinkedComponent: z.literal(true),
  componentType: z.enum(constants.modelFileComponentTypes),
  fileId: z.number(),
  modelId: z.number(),
  modelName: z.string(),
  versionName: z.string(),
  fileName: z.string(),
  isRequired: z.boolean().optional(),
});

export type LinkedComponentSettings = z.infer<typeof linkedComponentSettingsSchema>;

/** Union type for casting the RecommendedResource.settings JSON field from DB reads */
export type RecommendedResourceSettings = RecommendedSettingsSchema | LinkedComponentSettings;

export const setLinkedComponentsSchema = z.object({
  id: z.number(), // modelVersionId
  components: z.array(
    z.object({
      id: z.number().optional(), // RecommendedResource.id for existing entries
      resourceId: z.number(), // target ModelVersion ID
      settings: linkedComponentSettingsSchema,
    })
  ),
});

export type SetLinkedComponentsInput = z.infer<typeof setLinkedComponentsSchema>;

export const addLinkedComponentSchema = z.object({
  id: z.number(), // source model version ID (named `id` for isOwnerOrModerator middleware compat)
  targetVersionId: z.number(), // linked resource's version ID
  targetFileId: z.number().optional(), // explicit file to link; falls back to auto-picking the primary
  replaceFileId: z.number().optional(), // redundant file on the source version to delete after linking
  componentType: z.enum(constants.modelFileComponentTypes),
  modelId: z.number(),
  modelName: z.string(),
  versionName: z.string(),
  isRequired: z.boolean().optional().default(true),
});
export type AddLinkedComponentInput = z.infer<typeof addLinkedComponentSchema>;

export const linkOfficialFileByHashSchema = z.object({
  id: z.number(), // host version being edited; caller must own it
  sha256: z.string().min(1),
});
export type LinkOfficialFileByHashInput = z.infer<typeof linkOfficialFileByHashSchema>;

export type RecommendedResourceSchema = z.infer<typeof recommendedResourceSchema>;
const recommendedResourceSchema = z.object({
  id: z.number().optional(),
  resourceId: z.number(),
  settings: recommendedSettingsSchema.optional(),
});

export type ModelVersionUpsertInput = z.infer<typeof modelVersionUpsertSchema2>;

export const MAX_LICENSING_FEE = 100;

export type ModelVersionEarlyAccessConfig = z.infer<typeof modelVersionEarlyAccessConfigSchema>;
export const modelVersionEarlyAccessConfigSchema = z.object({
  timeframe: z.number(),
  chargeForDownload: z.boolean().default(false),
  downloadPrice: z.number().min(100).max(MAX_DONATION_GOAL).optional(),
  chargeForGeneration: z.boolean().default(false),
  generationPrice: z.number().min(50).optional(),
  generationTrialLimit: z.number().max(1000).default(10),
  donationGoalEnabled: z.boolean().default(false),
  donationGoal: z.number().min(MIN_DONATION_GOAL).max(MAX_DONATION_GOAL).optional(),
  donationGoalId: z.number().optional(),
  originalPublishedAt: z.coerce.date().optional(),
  freeGeneration: z.boolean().optional(),
});

export const earlyAccessConfigInput = modelVersionEarlyAccessConfigSchema;
// modelVersionEarlyAccessConfigSchema.omit({
//   buzzTransactionId: true,
// });

// Narrow input for editing only a version's early-access config (e.g. from the
// creator studio) without round-tripping the whole version. `id` is named for
// the `isOwnerOrModerator` middleware; a null config clears early access.
export type UpdateEarlyAccessConfigInput = z.infer<typeof updateEarlyAccessConfigSchema>;
export const updateEarlyAccessConfigSchema = z.object({
  id: z.number(),
  earlyAccessConfig: earlyAccessConfigInput.nullish(),
});

export const modelVersionUpsertSchema2 = z.object({
  modelId: z.number(),
  id: z.number().optional(),
  name: z.string().trim().min(1, 'Name cannot be empty.'),
  baseModel: z.string(),
  baseModelType: z.enum(constants.baseModelTypes).nullish(),
  description: getSanitizedStringSchema({
    allowedTags: ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br', 'ul', 'ol', 'li', 'code', 'pre'],
    stripEmpty: true,
  }).nullish(),
  steps: z.number().min(0).nullish(),
  epochs: z.number().min(0).max(100000).nullish(),
  clipSkip: z.number().min(1).max(12).nullish(),
  trainedWords: z.array(z.string()).optional(),
  trainingStatus: z.enum(TrainingStatus).nullish(),
  trainingDetails: trainingDetailsObj.nullish(),
  status: z.enum(ModelStatus).optional(),
  requireAuth: z.boolean().optional(),
  monetization: z
    .object({
      id: z.number().nullish(),
      type: z.enum(ModelVersionMonetizationType).nullish(),
      unitAmount: z.number().nullish(),
      sponsorshipSettings: z
        .object({
          type: z.enum(ModelVersionSponsorshipSettingsType),
          unitAmount: z.number().min(0),
        })
        .nullish(),
    })
    .nullish(),
  settings: recommendedSettingsSchema.nullish(),
  recommendedResources: z.array(recommendedResourceSchema).optional(),
  templateId: z.number().optional(),
  bountyId: z.number().optional(),
  earlyAccessConfig: earlyAccessConfigInput.nullish(),
  earlyAccessGoalConfig: z
    .object({
      unitAmount: z.number(),
    })
    .nullish(),
  uploadType: z.enum(ModelUploadType).optional(),
  usageControl: z.enum(ModelUsageControl).optional(),
  licensingFee: z.number().min(0).max(MAX_LICENSING_FEE).nullish(),
  licensingFeeType: z.enum(LicensingFeeType).nullish(),
  licensingFeeSettlementCurrency: z.enum(LicensingFeeSettlementCurrency).nullish(),
  // Inherit another version's licensing fee (a LicensingRoot for this baseModel).
  // Null falls back to the (baseModel, modelType) rule.
  licensingSourceVersionId: z.number().nullish(),
});

export type GetModelVersionSchema = z.infer<typeof getModelVersionSchema>;
export const getModelVersionSchema = z.object({
  id: z.number(),
  withFiles: z.boolean().optional(),
});

export type GetLicensingRootsSchema = z.infer<typeof getLicensingRootsSchema>;
export const getLicensingRootsSchema = z.object({
  baseModel: z.string(),
  modelType: z.enum(ModelType).optional(),
});

export type UpsertExplorationPromptInput = z.infer<typeof upsertExplorationPromptSchema>;
export const upsertExplorationPromptSchema = z.object({
  // This is the modelVersionId
  id: z.number(),
  // Including modelId to confirm ownership
  modelId: z.number().optional(),
  name: z.string().trim().min(1, 'Name cannot be empty.'),
  prompt: z.string().trim().min(1, 'Prompt cannot be empty.'),
  index: z.number().optional(),
});

export type DeleteExplorationPromptInput = z.infer<typeof deleteExplorationPromptSchema>;
export const deleteExplorationPromptSchema = z.object({
  id: z.number(),
  modelId: z.number().optional(),
  name: z.string().trim().min(1, 'Name cannot be empty.'),
});

export type GenerationAlias = { versionId: number; strength?: number };

export type ModelVersionMeta = ModelMeta & {
  picFinderModelId?: number;
  earlyAccessDownloadData?: { date: string; downloads: number }[];
  generationImagesCount?: { date: string; generations: number }[];
  hadEarlyAccessPurchase?: boolean;
  /**
   * When set, opening this version in the generator loads the target version's
   * resource instead of this one (a 1:1 redirect). The cover version derives
   * its `canGenerate` from the target, so the Create button hides on its own if
   * the target is deleted/unpublished/uncovered (fail-closed).
   */
  generationAlias?: GenerationAlias;
};

export type PublishVersionInput = z.infer<typeof publishVersionSchema>;
export const publishVersionSchema = z.object({
  id: z.number(),
  publishedAt: z.date().optional(),
});

export type GetModelVersionByModelTypeProps = z.infer<typeof getModelVersionByModelTypeSchema>;
export const getModelVersionByModelTypeSchema = z.object({
  type: z.enum(ModelType),
  query: z.string().optional(),
  baseModel: z.string().optional(),
  take: z.number().default(100),
});

export type ImageModelVersionDetail = z.infer<typeof imageModelVersionDetailSchema>;
export type CharacterModelVersionDetail = z.infer<typeof characterModelVersionDetailSchema>;
export type TextModelVersionDetail = z.infer<typeof textModelVersionDetailSchema>;
export type AudioModelVersionDetail = z.infer<typeof audioModelVersionDetailSchema>;

export const imageModelVersionDetailSchema = z.object({
  trainedWords: z.string().array().default([]),
  steps: z.number().optional(),
  epochs: z.number().optional(),
  baseModel: z.string(),
  //modelversion recommendations
  clipSkip: z.number().optional(),
});
export const characterModelVersionDetailSchema = z.object({});
export const textModelVersionDetailSchema = z.object({});
export const audioModelVersionDetailSchema = z.object({});

export type EarlyAccessModelVersionsOnTimeframeSchema = z.infer<
  typeof earlyAccessModelVersionsOnTimeframeSchema
>;
export const earlyAccessModelVersionsOnTimeframeSchema = z.object({
  timeframe: z.number().optional(),
});

export type ModelVersionsGeneratedImagesOnTimeframeSchema = z.infer<
  typeof modelVersionsGeneratedImagesOnTimeframeSchema
>;
export const modelVersionsGeneratedImagesOnTimeframeSchema = z.object({
  timeframe: z.number().optional(),
});

export type ModelVersionEarlyAccessPurchase = z.infer<typeof modelVersionEarlyAccessPurchase>;
export const modelVersionEarlyAccessPurchase = z.object({
  modelVersionId: z.number(),
  type: z.enum(['download', 'generation']),
});

export type GetModelVersionPopularityInput = z.infer<typeof getModelVersionPopularityInput>;
export const getModelVersionPopularityInput = z.object({
  id: z.number(),
});

export type GetModelVersionsPopularityInput = z.infer<typeof getModelVersionsPopularityInput>;
export const getModelVersionsPopularityInput = z.object({
  ids: z.array(z.number()),
});

export type GetModelVersionsByIdsInput = z.infer<typeof getModelVersionsByIdsInput>;
export const getModelVersionsByIdsInput = z.object({
  ids: z.array(z.number()).max(50),
});

export type MergeVersionsInput = z.infer<typeof mergeVersionsSchema>;
export const mergeVersionsSchema = z.object({
  modelId: z.number(),
  targetVersionId: z.number(),
  sourceVersionIds: z.array(z.number()).min(1),
  fileTypeMappings: z
    .array(
      z.object({
        fileId: z.number(),
        type: z.enum(constants.modelFileTypes).optional(),
        metadata: z
          .object({
            fp: z.string().max(64).nullish(),
            size: z.enum(constants.modelFileSizes).nullish(),
            format: z.enum(constants.modelFileFormats).nullish(),
            quantType: z.string().max(64).nullish(),
            isRequired: z.boolean().nullish(),
          })
          .optional(),
      })
    )
    .optional(),
  appendDescriptions: z.boolean().default(false),
});
