import * as z from 'zod';

/**
 * Scanner-policies test bench — zod schemas.
 *
 * The test bench is moderator-only and stores candidate policies in sysRedis.
 * See docs/scanner-policies/PLAN.md for the full design. These schemas are the
 * authoritative contract for the tRPC router + service layer.
 */

export const scannerPolicyModeSchema = z.enum(['prompt', 'text']);
export type ScannerPolicyMode = z.infer<typeof scannerPolicyModeSchema>;

export const scannerPolicyStatusSchema = z.enum(['draft', 'ready', 'shipped', 'archived']);
export type ScannerPolicyStatus = z.infer<typeof scannerPolicyStatusSchema>;

/**
 * The full candidate as it lives in sysRedis. `id`, `policyHash`, and the
 * created/updated timestamps are server-assigned and never come from the
 * client.
 */
export const scannerPolicyCandidateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  mode: scannerPolicyModeSchema,
  // Label name is free-form so moderators can add new labels. Validate format
  // (no `:` so the composite hash field stays unambiguous; no leading/trailing
  // whitespace).
  label: z
    .string()
    .min(1)
    .max(80)
    .regex(
      /^[^\s:][^:]*[^\s:]$|^[^\s:]$/,
      'Label cannot contain `:` or leading/trailing whitespace'
    ),
  threshold: z.number().min(0).max(1),
  status: scannerPolicyStatusSchema,
  active: z.boolean(),
  policy: z.string().min(1).max(20_000),
  notes: z.string().max(5_000).optional(),
  createdBy: z.number().int(),
  createdAt: z.string(), // ISO
  updatedAt: z.string(),
  policyHash: z.string().min(1),
});
export type ScannerPolicyCandidate = z.infer<typeof scannerPolicyCandidateSchema>;

/** Inputs the moderator sends when creating or updating a candidate. */
export const upsertCandidateInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(200),
  mode: scannerPolicyModeSchema,
  label: scannerPolicyCandidateSchema.shape.label,
  threshold: z.number().min(0).max(1),
  status: scannerPolicyStatusSchema,
  active: z.boolean().default(false),
  policy: z.string().min(1).max(20_000),
  notes: z.string().max(5_000).optional(),
});
export type UpsertCandidateInput = z.infer<typeof upsertCandidateInputSchema>;

export const setActiveInputSchema = z.object({
  mode: scannerPolicyModeSchema,
  label: scannerPolicyCandidateSchema.shape.label,
  id: z.string().min(1),
  active: z.boolean(),
});
export type SetActiveInput = z.infer<typeof setActiveInputSchema>;

export const deleteCandidateInputSchema = z.object({
  mode: scannerPolicyModeSchema,
  label: scannerPolicyCandidateSchema.shape.label,
  id: z.string().min(1),
});
export type DeleteCandidateInput = z.infer<typeof deleteCandidateInputSchema>;

export const listCandidatesInputSchema = z.object({
  mode: scannerPolicyModeSchema,
  label: scannerPolicyCandidateSchema.shape.label,
});
export type ListCandidatesInput = z.infer<typeof listCandidatesInputSchema>;

export const deleteLabelInputSchema = z.object({
  mode: scannerPolicyModeSchema,
  label: scannerPolicyCandidateSchema.shape.label,
});
export type DeleteLabelInput = z.infer<typeof deleteLabelInputSchema>;

export const exportDatasetInputSchema = z.object({
  mode: scannerPolicyModeSchema,
  label: scannerPolicyCandidateSchema.shape.label,
  max: z.number().int().min(1).max(5_000),
});
export type ExportDatasetInput = z.infer<typeof exportDatasetInputSchema>;

/**
 * Shape of one row inside the input `Test Cases` sheet of an exported workbook
 * (and the contract the run-tests endpoint validates after parsing).
 */
export const testCaseRowSchema = z.object({
  contentHash: z.string().min(1),
  label: z.string().min(1),
  verdict: z.enum(['TP', 'FP', 'TN', 'FN']),
  expectedTrigger: z.boolean(),
  modCount: z.number().int().min(1).optional(),
  agreementCount: z.number().int().min(1).optional(),
  positivePrompt: z.string(),
  negativePrompt: z.string().optional(),
});
export type TestCaseRow = z.infer<typeof testCaseRowSchema>;

export const listExportsInputSchema = z.object({
  mode: scannerPolicyModeSchema,
  label: scannerPolicyCandidateSchema.shape.label,
});
export type ListExportsInput = z.infer<typeof listExportsInputSchema>;

export const startRunInputSchema = z.object({
  datasetId: z.string().min(1),
});
export type StartRunInput = z.infer<typeof startRunInputSchema>;

export const getDownloadUrlInputSchema = z.object({
  exportId: z.string().min(1),
});
export type GetDownloadUrlInput = z.infer<typeof getDownloadUrlInputSchema>;

export const deleteExportInputSchema = z.object({
  exportId: z.string().min(1),
});
export type DeleteExportInput = z.infer<typeof deleteExportInputSchema>;

export const cancelRunInputSchema = z.object({
  runId: z.string().min(1),
});
export type CancelRunInput = z.infer<typeof cancelRunInputSchema>;

export const getSystemPromptInputSchema = z.object({
  mode: scannerPolicyModeSchema,
});
export type GetSystemPromptInput = z.infer<typeof getSystemPromptInputSchema>;

export const setSystemPromptInputSchema = z
  .object({
    mode: scannerPolicyModeSchema,
    body: z.string().max(50_000).optional(),
    clear: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.clear) !== (v.body !== undefined), {
    message: 'Provide exactly one of `body` (override text) or `clear: true` (revert to live)',
  });
export type SetSystemPromptInput = z.infer<typeof setSystemPromptInputSchema>;

/**
 * Per-dataset record kept in sysRedis so the UI can list past datasets and
 * the test runs applied to each. One workbook per dataset; runs append rows
 * to the workbook's Results sheet in place rather than producing a separate
 * file.
 */
export const datasetExportRecordSchema = z.object({
  id: z.string().min(1),
  mode: scannerPolicyModeSchema,
  label: scannerPolicyCandidateSchema.shape.label,
  filename: z.string(),
  s3Key: z.string(),
  rowCount: z.number().int(),
  createdBy: z.number().int(),
  createdAt: z.string(),
  // Updated when a scoring run completes against this dataset. `lastRunAt`
  // doubles as "has-results" flag.
  lastRunId: z.string().optional(),
  lastRunAt: z.string().optional(),
  lastRunBy: z.number().int().optional(),
  lastRunCandidateIds: z.array(z.string()).optional(),
});
export type DatasetExportRecord = z.infer<typeof datasetExportRecordSchema>;

/**
 * Payload pushed to the moderator via SignalMessages.ScannerPolicyTestProgress.
 * The runner picks this up via useSignalConnection from the scanner-policies
 * page; closing the page detaches the listener (lazy gating).
 */
export type ScannerPolicyTestProgressData = {
  runId: string;
  phase: 'started' | 'progress' | 'done' | 'error' | 'cancelled';
  processed: number;
  total: number;
  currentCandidate?: string;
  /**
   * Set on terminal `done` / `cancelled` phases. The client passes this to
   * `scannerPolicies.getDownloadUrl({ exportId })` to mint a fresh signed URL
   * — we don't put the signed URL in the signal directly because it would
   * expire while sitting in the signal payload.
   */
  exportId?: string;
  errorMessage?: string;
};
