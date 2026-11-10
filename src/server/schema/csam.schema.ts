import { CsamReportType } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { zodEnumFromObjKeys } from '~/utils/zod-helpers';

export type CsamCapabilityType = keyof typeof csamCapabilitiesDictionary;
export const csamCapabilitiesDictionary = {
  create: 'create novel images/videos from textual inputs, such as describing a scene or an object',
  edit: 'edit existing images/videos by providing textual descriptions of the desired changes, such as adding or removing elements, changing colors, or altering expressions',
  generate:
    'generate multiple variations of an uploaded or generated image/video, such as changing the style, perspective, or background of the image',
  blend:
    'blend or mix different images or concepts together, such as combining faces, animals, or landscapes',
} as const;

export type CsamContentType = keyof typeof csamContentsDictionary;
export const csamContentsDictionary = {
  nonRealMinors: 'AI-generated images/videos of non-real minors',
  realMinors: 'AI-edited images/videos of real minors',
  variations: 'AI-generated variations of uploaded CSAM',
  other: 'AI-generated sexualization of uploaded images/videos of minors',
} as const;

export type ConsumerStrikeDetailsSchema = z.infer<typeof consumerStrikeDetailsSchema>;
const consumerStrikeDetailsSchema = z.object({
  blobs: z.object({ url: z.string() }).array(),
  jobId: z.string(),
  prompt: z.string().optional(),
  negativePrompt: z.string().optional(),
  resources: z.string().array().optional(),
  dateTime: z.date().optional(),
});

// #region [user input]
export type CsamReportFormInput = z.input<typeof csamReportDetails>;
export type CsamReportFormOutput = z.output<typeof csamReportDetails>;
export const csamReportDetails = z.object({
  modelVersionIds: z.number().array().optional(),
  minorDepiction: z.enum(['real', 'non-real']).optional(),
  capabilities: zodEnumFromObjKeys(csamCapabilitiesDictionary).array().optional(),
  contents: zodEnumFromObjKeys(csamContentsDictionary).array().optional(),
  generatedImages: consumerStrikeDetailsSchema.array().optional(),
  // trainingData: trainingDataSchema.array().optional(),
  // userActivity: userActivitySchema.array().optional(),
});

export type CsamContextSources = z.infer<typeof csamContextSourcesSchema>;
export const csamContextSourcesSchema = z.object({
  postIds: z.number().int().positive().array().max(100),
  commentIds: z.number().int().positive().array().max(500),
});

export type CreateCsamReportSchema = z.infer<typeof createCsamReportSchema>;
export const createCsamReportSchema = z.object({
  userId: z.number(),
  imageIds: z.number().array().optional(),
  details: csamReportDetails.optional(),
  type: z.enum(CsamReportType),
  /** A sent image report on the same user that this one supplements. */
  supplementalOf: z.number().int().positive().optional(),
  contextSources: csamContextSourcesSchema.optional(),
});

export type GetCsamContextCandidatesSchema = z.infer<typeof getCsamContextCandidatesSchema>;
export const getCsamContextCandidatesSchema = z.object({
  userId: z.number().int(),
  imageIds: z.number().int().positive().array().max(1000),
});

export type GetCsamSupplementalPreviewSchema = z.infer<typeof getCsamSupplementalPreviewSchema>;
export const getCsamSupplementalPreviewSchema = z.object({
  userId: z.number().int().positive(),
  imageIds: z.number().int().positive().array().max(1000),
  supplementalOf: z.number().int().positive(),
});

// #endregion

export type GetImageResourcesOutput = z.output<typeof getImageResourcesSchema>;
export const getImageResourcesSchema = z.object({
  ids: z.number().array(),
});

// #region [external link report]
// File-level annotations the moderator can toggle for externally-sourced CSAM.
// Unlike in-app generated content, this is usually real (non-AI) imagery, so
// `generativeAi` is opt-in here rather than defaulted to true.
export const externalCsamFileAnnotationsSchema = z.object({
  generativeAi: z.boolean().optional(),
  infant: z.boolean().optional(),
  bestiality: z.boolean().optional(),
  violenceGore: z.boolean().optional(),
  physicalHarm: z.boolean().optional(),
});

export type CreateExternalCsamReportSchema = z.infer<typeof createExternalCsamReportSchema>;
export const createExternalCsamReportSchema = z.object({
  // required
  userId: z.number(),
  email: z.string().email(),
  // optional identity
  screenName: z.string().trim().optional(),
  reportedName: z.string().trim().optional(),
  // URLs are informational text in the report; kept as plain strings so a
  // malformed link can't block a time-sensitive CSAM filing.
  profileUrls: z.array(z.string().trim().min(1)).optional(),
  secondaryUserId: z.number().optional(),
  secondaryEmail: z.string().email().optional().or(z.literal('')),
  // optional incident context
  externalUrls: z.array(z.string().trim().min(1)).optional(),
  incidentDateTime: z.coerce.date().optional(),
  minorDepiction: z.enum(['real', 'non-real']).optional(),
  contents: zodEnumFromObjKeys(csamContentsDictionary).array().optional(),
  fileAnnotations: externalCsamFileAnnotationsSchema.optional(),
  // chat / distribution context
  chatPlatform: z.string().trim().optional(), // e.g. Discord, Telegram
  chatLogs: z.string().optional(), // pasted transcript text
  additionalInfo: z.string().optional(),
  // uploaded CSAM evidence zip (stored in the CSAM bucket) -> reported as the abuse material
  evidence: z
    .object({
      bucketKey: z.string(),
      filename: z.string(),
    })
    .optional(),
  // uploaded chat-log screenshots zip -> reported as supplemental (contextual) evidence
  supplementalEvidence: z
    .object({
      bucketKey: z.string(),
      filename: z.string(),
    })
    .optional(),
});
// #endregion

/** A preserve request reads every workflow and copies every file inside one API call. */
export const MAX_WORKFLOWS_PER_PRESERVE = 10;
/** Every file of the request is probed and copied inside the same call. */
export const MAX_FILES_PER_PRESERVE = 100;

const cyberTipNumber = z.number().int().positive().max(9_999_999_999);
const priorCTReportsSchema = cyberTipNumber.array().max(20).optional();

export const generatorEvidenceUserSchema = z.object({ userId: z.number().int().positive() });

export const generatorEvidenceWorkflowsSchema = generatorEvidenceUserSchema.extend({
  cursor: z.string().max(200).optional(),
});

export type PreserveGeneratorEvidenceSchema = z.infer<typeof preserveGeneratorEvidenceSchema>;
export const preserveGeneratorEvidenceSchema = generatorEvidenceUserSchema
  .extend({
    workflowIds: z.string().min(1).max(100).array().max(100).default([]),
    triggers: z
      .object({
        restrictionId: z.number().int().positive(),
        index: z.number().int().min(0).max(10_000),
      })
      .array()
      .max(200)
      .default([]),
    priorCTReports: priorCTReportsSchema,
    manifestKey: z.string().min(1).max(300).optional(),
  })
  .refine((input) => input.workflowIds.length + input.triggers.length > 0 || !!input.manifestKey, {
    message: 'Pick at least one workflow or trigger, or name a manifest.',
  });

export const approveGeneratorEvidenceSchema = generatorEvidenceUserSchema.extend({
  reportId: z.number().int().positive(),
  version: z.string().min(1).max(64),
  priorCTReports: priorCTReportsSchema,
});

export const generatorEvidenceFileSchema = generatorEvidenceUserSchema.extend({
  reportId: z.number().int().positive(),
  blobId: z.string().min(1).max(300),
});

export const excludeGeneratorEvidenceFileSchema = generatorEvidenceFileSchema.extend({
  reason: z.string().trim().min(3).max(1000),
});

export const clearUnconfirmedOpenSchema = z.object({
  reportId: z.number().int().positive(),
  /** What the moderator checked with NCMEC before clearing it. */
  note: z.string().trim().min(3).max(1000),
});
