/** Shared by the mini epoch caller-gate tests: a Private version whose file carries training epochs. */

export const VERSION_ID = 555;
export const OWNER_ID = 4242;
export const GRANTEE_ID = 7001;
export const SERVICE_TOKEN = 'test-service-token-0123456789abcdef';

export const EPOCH_URL =
  'https://orchestration.civitai.com/v2/consumer/jobs/job-abc-123/assets/epoch-000010.safetensors';

export const versionRow = {
  id: VERSION_ID,
  versionName: 'v1',
  availability: 'Private',
  publishedAt: new Date('2024-01-01T00:00:00Z'),
  modelId: 77,
  modelName: 'Test Model',
  baseModel: 'SD 1.5',
  status: 'Published',
  modelStatus: 'Published',
  modelMode: null as string | null,
  type: 'LORA',
  requireAuth: false,
  checkPermission: false,
  covered: true,
  isPromoted: false,
  generationAlias: null,
  minor: false,
  sfwOnly: false,
  usageControl: 'Download',
  modelUserId: OWNER_ID,
  poi: false,
  licensingFee: null,
  licensingFeeType: null,
  licensingFeeSettlementCurrency: null,
  isLicensingRoot: false,
  licensingSourceVersionId: null,
  sourceLicensingFeeRecipientUserId: null,
  sourceModelType: null,
  sourceBaseModel: null,
  sourceLicensingFee: null,
  sourceLicensingFeeType: null,
  sourceLicensingFeeSettlementCurrency: null,
  versionFlags: 0,
  userFlags: 0,
};

export const TRAINING_FILE = {
  id: 404,
  type: 'Model',
  visibility: 'Private',
  url: 'https://example.invalid/d.safetensors',
  metadata: {
    format: 'SafeTensor',
    trainingResults: { epochs: [{ epoch_number: 10, model_url: EPOCH_URL }] },
  },
  sizeKB: 131_072,
  name: 'epoch-000010.safetensors',
  hashes: { SHA256: 'D'.repeat(64) },
};
