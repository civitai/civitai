import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Regression coverage for `GET /api/v1/model-versions/mini/[id]`.
 *
 * The endpoint used to make TWO INDEPENDENT file selections for one response:
 *
 *   1. the metadata fields (`size`, `fileType`, `fileName`, `hashes`) were read
 *      off the file this handler picked (`getPrimaryFile` over the version's
 *      files, with hardcoded default preferences), and
 *   2. `downloadUrl` was emitted as `?primary=true`, which DELEGATES the choice
 *      to `/api/download/models/[modelVersionId]` — a route that re-runs
 *      `getPrimaryFile` itself, over a DIFFERENT population (visibility-filtered)
 *      and with DIFFERENT preferences (the requesting user's `filePreferences`
 *      merged in).
 *
 * On a multi-file version those two picks diverge, and the response then
 * advertises file A's SHA256/size/name next to a URL that serves file B. Any
 * consumer that verifies the hash fails, permanently.
 *
 * The contract pinned here: the URL names the file whose metadata was returned.
 */

const {
  mockQueryRaw,
  mockResolveCanGenerateForVersions,
  mockGetShouldChargeForResources,
  mockGetFeaturedModels,
  mockGetCapTiers,
  currentUser,
} = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockResolveCanGenerateForVersions: vi.fn(),
  mockGetShouldChargeForResources: vi.fn(),
  mockGetFeaturedModels: vi.fn(),
  mockGetCapTiers: vi.fn(),
  currentUser: { value: undefined as undefined | Record<string, unknown> },
}));

vi.mock('~/server/db/client', () => ({
  dbWrite: { $queryRaw: mockQueryRaw },
  dbRead: { $queryRaw: mockQueryRaw },
}));

vi.mock('~/server/services/generation/generation.service', () => ({
  resolveCanGenerateForVersions: mockResolveCanGenerateForVersions,
  getShouldChargeForResources: mockGetShouldChargeForResources,
}));

vi.mock('~/server/services/model.service', () => ({
  getFeaturedModels: mockGetFeaturedModels,
}));

vi.mock('~/server/services/paid-access.service', () => ({
  getCapTiers: mockGetCapTiers,
}));

// MixedAuthEndpoint resolves the (optional) session and passes it as the 3rd
// argument. Swap it for a pass-through that injects whatever `currentUser`
// holds, so the owner/moderator branches are reachable from a test.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, currentUser.value),
}));

import handler from '~/pages/api/v1/model-versions/mini/[id]';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getPrimaryFile } from '~/server/utils/model-helpers';

const VERSION_ID = 555;
const OWNER_ID = 4242;

/**
 * Two files that the two selection paths genuinely disagree about.
 *
 * - SAFETENSOR wins `getPrimaryFile` under the DEFAULT preferences the mini
 *   endpoint hardcodes (format SafeTensor +100, size pruned +10, fp16 +1).
 * - GGUF wins it under a user whose `filePreferences.format` is `GGUF` — which
 *   is exactly what the download route merges in. That divergence is asserted
 *   directly below so this fixture cannot silently stop being discriminating.
 */
const SAFETENSOR = {
  id: 101,
  type: 'Model',
  visibility: 'Public',
  url: 'https://example.invalid/a.safetensors',
  metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
  sizeKB: 2_097_152,
  name: 'model-fp16.safetensors',
  hashes: { SHA256: 'A'.repeat(64) },
};
const GGUF = {
  id: 202,
  type: 'Model',
  visibility: 'Public',
  url: 'https://example.invalid/b.gguf',
  metadata: { format: 'GGUF', quantType: 'Q4_K_M' },
  sizeKB: 1_048_576,
  name: 'model-Q4_K_M.gguf',
  hashes: { SHA256: 'B'.repeat(64) },
};
const PRIVATE_MODEL = {
  id: 303,
  type: 'Model',
  visibility: 'Private',
  url: 'https://example.invalid/c.safetensors',
  metadata: { format: 'SafeTensor', size: 'full', fp: 'fp32' },
  sizeKB: 4_194_304,
  name: 'private-full.safetensors',
  hashes: { SHA256: 'C'.repeat(64) },
};

const versionRow = {
  id: VERSION_ID,
  versionName: 'v1',
  availability: 'Public',
  publishedAt: new Date('2024-01-01T00:00:00Z'),
  modelId: 77,
  modelName: 'Test Model',
  baseModel: 'SD 1.5',
  status: 'Published',
  type: 'Checkpoint',
  requireAuth: false,
  checkPermission: false,
  covered: true,
  generationAlias: null,
  minor: false,
  sfwOnly: false,
  usageControl: 'Download',
  modelUserId: OWNER_ID,
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

type Body = {
  size: number;
  fileType: string;
  fileName: string;
  hashes: Record<string, string>;
  downloadUrls: string[];
};

async function run(files: object[], query: Record<string, string> = {}) {
  // Call 1 = the version row, call 2 = the version's ModelFile rows.
  mockQueryRaw.mockResolvedValueOnce([versionRow]).mockResolvedValueOnce(files);

  const req = {
    method: 'GET',
    query: { id: String(VERSION_ID), ...query },
    headers: { host: 'civitai.com' },
  } as unknown as NextApiRequest;

  const json = vi.fn().mockReturnThis();
  const res = {
    status: vi.fn().mockReturnThis(),
    json,
    setHeader: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;

  await handler(req, res);
  return {
    res,
    status: (res.status as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as number,
    body: json.mock.calls.at(-1)?.[0] as Body,
  };
}

/** The `fileId` query param on the single emitted download url, if any. */
function urlFileId(body: Body): string | null {
  return new URL(body.downloadUrls[0]).searchParams.get('fileId');
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.value = undefined;
  mockQueryRaw.mockReset();
  mockResolveCanGenerateForVersions.mockResolvedValue(
    new Map([[VERSION_ID, { canGenerate: true }]])
  );
  mockGetShouldChargeForResources.mockResolvedValue({ 77: false });
  mockGetFeaturedModels.mockResolvedValue([]);
  mockGetCapTiers.mockResolvedValue(new Map());
});

describe('createModelFileDownloadUrl', () => {
  it('emits ?fileId= and suppresses the type/format/size/fp/quantType selectors', () => {
    const url = createModelFileDownloadUrl({
      versionId: VERSION_ID,
      fileId: SAFETENSOR.id,
      type: 'Model',
      meta: { format: 'SafeTensor', size: 'pruned', fp: 'fp16', quantType: 'Q4_K_M' },
    });
    const params = new URL(url, 'https://civitai.com').searchParams;
    expect(params.get('fileId')).toBe(String(SAFETENSOR.id));
    for (const k of ['type', 'format', 'size', 'fp', 'quantType', 'primary'])
      expect(params.get(k), `${k} must not be emitted alongside fileId`).toBeNull();
  });
});

describe('the fixture is discriminating', () => {
  it('the two selection paths really do pick different files from it', () => {
    // What the mini endpoint picks (hardcoded defaults).
    expect(getPrimaryFile([SAFETENSOR, GGUF])?.id).toBe(SAFETENSOR.id);
    // What the download route picks for a user whose filePreferences say GGUF —
    // the merge the download route performs on every request.
    expect(
      getPrimaryFile([SAFETENSOR, GGUF], {
        metadata: { format: 'GGUF', size: 'pruned', fp: 'fp16', quantType: 'Q4_K_M' },
      })?.id
    ).toBe(GGUF.id);
  });
});

describe('GET /api/v1/model-versions/mini/[id] — url names the advertised file', () => {
  it('REGRESSION: downloadUrl carries the fileId of the file whose hashes/size were returned', async () => {
    const { status, body } = await run([SAFETENSOR, GGUF]);
    expect(status).toBe(200);

    // Positive control: the response really did describe a specific file.
    expect(body.hashes.SHA256).toBe(SAFETENSOR.hashes.SHA256);
    expect(body.fileName).toBe(SAFETENSOR.name);
    expect(body.size).toBe(SAFETENSOR.sizeKB);

    expect(
      urlFileId(body),
      'downloadUrl does not name the file whose hash/size/name this response advertised, so the ' +
        'download route re-picks and can serve a different file than the one described'
    ).toBe(String(SAFETENSOR.id));
    expect(body.downloadUrls[0]).not.toContain('primary=true');
  });

  it('row order does not change the answer — the url still names the returned file', async () => {
    // `getPrimaryFile` has no tiebreak and neither query has an ORDER BY, so the
    // reversed population is a legitimate second observation, not a duplicate.
    const { body } = await run([GGUF, SAFETENSOR]);
    expect(urlFileId(body)).toBe(String(SAFETENSOR.id));
    expect(body.fileName).toBe(SAFETENSOR.name);
  });

  it('an explicit modelFileId is honoured and matches the url', async () => {
    const { body } = await run([SAFETENSOR, GGUF], { modelFileId: String(GGUF.id) });
    expect(body.fileName).toBe(GGUF.name);
    expect(urlFileId(body)).toBe(String(GGUF.id));
  });
});

describe('GET /api/v1/model-versions/mini/[id] — non-public files', () => {
  /**
   * The mini query does not filter `visibility`, so a non-Public file could be
   * selected and its hash/name/size advertised. Pinning `fileId` on the url
   * makes the download route's fileId branch enforce
   * `visibility = Public` for a non-owner/non-mod — a 404 — so the endpoint must
   * not advertise such a file to those callers in the first place. The rule
   * mirrors the download route's exactly: owner/moderator see everything.
   */
  it('an anonymous caller never gets a non-public file advertised', async () => {
    const { body } = await run([PRIVATE_MODEL, SAFETENSOR, GGUF]);
    expect(body.fileName).toBe(SAFETENSOR.name);
    expect(urlFileId(body)).toBe(String(SAFETENSOR.id));
  });

  it('an anonymous caller asking for a non-public file by id gets 404, not its hashes', async () => {
    const { status, body } = await run([PRIVATE_MODEL, SAFETENSOR], {
      modelFileId: String(PRIVATE_MODEL.id),
    });
    expect(status).toBe(404);
    expect(body).not.toHaveProperty('hashes');
  });

  it('the owner still sees their own non-public file, and the url names it', async () => {
    currentUser.value = { id: OWNER_ID };
    const { body } = await run([PRIVATE_MODEL, SAFETENSOR], {
      modelFileId: String(PRIVATE_MODEL.id),
    });
    expect(body.fileName).toBe(PRIVATE_MODEL.name);
    expect(urlFileId(body)).toBe(String(PRIVATE_MODEL.id));
  });

  it('a moderator still sees a non-public file', async () => {
    currentUser.value = { id: 1, isModerator: true };
    const { body } = await run([PRIVATE_MODEL, SAFETENSOR], {
      modelFileId: String(PRIVATE_MODEL.id),
    });
    expect(body.fileName).toBe(PRIVATE_MODEL.name);
    expect(urlFileId(body)).toBe(String(PRIVATE_MODEL.id));
  });
});
