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
const OTHER_USER_ID = 9001;

/**
 * Files that the selection paths genuinely disagree about.
 *
 * - SAFETENSOR wins `getPrimaryFile` among the PUBLIC files under the default
 *   preferences (format SafeTensor +100, fp16 +1; its `size: full` costs -10).
 * - GGUF wins it under a user whose `filePreferences.format` is `GGUF`.
 * - PRIVATE_MODEL is a perfect match for the defaults (SafeTensor + pruned +
 *   fp16) and therefore OUT-SCORES SAFETENSOR. That is deliberate: it makes the
 *   visibility filter load-bearing on the primary path, so a mutant that runs
 *   `getPrimaryFile` over the UNFILTERED population changes the answer.
 *
 * All three divergences are asserted directly below so this fixture cannot
 * silently stop being discriminating.
 */
const SAFETENSOR = {
  id: 101,
  type: 'Model',
  visibility: 'Public',
  url: 'https://example.invalid/a.safetensors',
  metadata: { format: 'SafeTensor', size: 'full', fp: 'fp16' },
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
  metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
  sizeKB: 4_194_304,
  name: 'private-pruned.safetensors',
  hashes: { SHA256: 'C'.repeat(64) },
};

/**
 * A training-results file on a Private version. Its `downloadUrl` comes from the
 * orchestrator (`epoch.model_url`), NOT from
 * `/api/download/models/[modelVersionId]` — so the visibility gate that exists
 * to keep the download route from 404ing a non-Public `fileId` must not apply
 * to it. Such a file is non-Public by construction, so gating it would 404 an
 * epoch url that previously worked for every non-owner caller.
 */
const EARLIER_EPOCH_URL =
  'https://orchestration.civitai.com/v2/consumer/jobs/job-abc-123/assets/epoch-000009.safetensors';
const EPOCH_URL =
  'https://orchestration.civitai.com/v2/consumer/jobs/job-abc-123/assets/epoch-000010.safetensors';
const TRAINING_FILE = {
  id: 404,
  type: 'Model',
  visibility: 'Private',
  url: 'https://example.invalid/d.safetensors',
  metadata: {
    format: 'SafeTensor',
    // Two epochs, so "the LAST epoch is the one served" is an observable
    // property rather than a tautology on a single-element array.
    trainingResults: {
      epochs: [
        { epoch_number: 9, model_url: EARLIER_EPOCH_URL },
        { epoch_number: 10, model_url: EPOCH_URL },
      ],
    },
  },
  sizeKB: 131_072,
  name: 'epoch-000010.safetensors',
  hashes: { SHA256: 'D'.repeat(64) },
};

/**
 * The same shape, but Public and on a Public version. The epoch branch is
 * `Private && trainingResults` — carrying training results is NOT on its own a
 * reason to hand back an orchestrator url, so this file must go down the
 * download-route path like any other.
 */
const PUBLIC_TRAINING_FILE = {
  ...TRAINING_FILE,
  id: 505,
  visibility: 'Public',
  name: 'public-epoch-000010.safetensors',
  hashes: { SHA256: 'E'.repeat(64) },
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
  air: string;
  size: number;
  fileType: string;
  fileName: string;
  hashes: Record<string, string>;
  downloadUrls: string[];
};

async function run(
  files: object[],
  query: Record<string, string> = {},
  versionOverrides: Partial<typeof versionRow> = {}
) {
  // Call 1 = the version row, call 2 = the version's ModelFile rows.
  // Deep-clone: the handler's epoch selection ends in `epochs?.pop()`, which
  // MUTATES the metadata it was handed. A real request re-reads the rows from
  // Postgres every time, so sharing a module-level fixture across tests would be
  // the only place that mutation is observable — and it would drain the epochs
  // array after the first use.
  mockQueryRaw
    .mockResolvedValueOnce([{ ...versionRow, ...versionOverrides }])
    .mockResolvedValueOnce(structuredClone(files));

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

const GGUF_PREFERENCES = {
  format: 'GGUF' as const,
  size: 'pruned' as const,
  fp: 'fp16' as const,
  quantType: 'Q4_K_M' as const,
  imageFormat: 'optimized' as const,
};

describe('the fixture is discriminating', () => {
  it('the two selection paths really do pick different files from it', () => {
    // What the mini endpoint picks under the defaults.
    expect(getPrimaryFile([SAFETENSOR, GGUF])?.id).toBe(SAFETENSOR.id);
    // What a user whose filePreferences say GGUF should get — the merge the
    // download route performs on every request, and (after this change) the
    // mini endpoint too.
    expect(getPrimaryFile([SAFETENSOR, GGUF], { metadata: GGUF_PREFERENCES })?.id).toBe(GGUF.id);
  });

  it('the non-public file OUT-SCORES the public one, so filtering changes the answer', () => {
    // If this ever stops holding, every "non-public file is not advertised"
    // assertion below passes vacuously: the public file would win regardless of
    // whether the population was filtered.
    expect(getPrimaryFile([PRIVATE_MODEL, SAFETENSOR, GGUF])?.id).toBe(PRIVATE_MODEL.id);
    expect(getPrimaryFile([SAFETENSOR, GGUF])?.id).toBe(SAFETENSOR.id);
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

    // The pre-fix url was a BARE `/api/download/models/<versionId>` with no
    // query string at all — `createModelFileDownloadUrl`'s `primary` flag only
    // suppresses the other selectors, and `QS.stringify` never emits a `primary`
    // key. So asserting the absence of `primary=true` guarded a string that
    // never existed. Assert the shape the url must actually have instead.
    expect(body.downloadUrls[0]).toMatch(
      new RegExp(`/api/download/models/${VERSION_ID}\\?fileId=${SAFETENSOR.id}$`)
    );
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

  /**
   * The gate is `user.id === modelVersion.modelUserId`, not `!!user.id`. Without
   * these two cases, replacing the ownership comparison with a bare
   * authentication check is invisible: every other case is either anonymous, the
   * owner, or a moderator.
   */
  it('an AUTHENTICATED non-owner is treated exactly like an anonymous caller', async () => {
    currentUser.value = { id: OTHER_USER_ID };
    const { body } = await run([PRIVATE_MODEL, SAFETENSOR, GGUF]);
    expect(body.fileName).toBe(SAFETENSOR.name);
    expect(body.hashes.SHA256).toBe(SAFETENSOR.hashes.SHA256);
    expect(urlFileId(body)).toBe(String(SAFETENSOR.id));
  });

  it('an AUTHENTICATED non-owner asking for a non-public file by id gets 404', async () => {
    currentUser.value = { id: OTHER_USER_ID };
    const { status, body } = await run([PRIVATE_MODEL, SAFETENSOR], {
      modelFileId: String(PRIVATE_MODEL.id),
    });
    expect(status).toBe(404);
    expect(body).not.toHaveProperty('hashes');
  });
});

describe("GET /api/v1/model-versions/mini/[id] — the caller's file preferences", () => {
  /**
   * The download route merges `user.filePreferences` into `getPrimaryFile`
   * (`getFileForModelVersion`). Pinning the url to a `fileId` removed the only
   * place those preferences were ever applied, so a GGUF-preferring user would
   * silently be handed the SafeTensor. The endpoint has to apply them itself
   * now — and the url must still name the file it picked.
   */
  it('a GGUF-preferring user is advertised the GGUF file, and the url names it', async () => {
    currentUser.value = { id: OTHER_USER_ID, filePreferences: GGUF_PREFERENCES };
    const { status, body } = await run([SAFETENSOR, GGUF]);
    expect(status).toBe(200);
    expect(body.fileName).toBe(GGUF.name);
    expect(body.hashes.SHA256).toBe(GGUF.hashes.SHA256);
    expect(body.size).toBe(GGUF.sizeKB);
    expect(urlFileId(body)).toBe(String(GGUF.id));
  });

  it('a user with no preferences still gets the default pick', async () => {
    currentUser.value = { id: OTHER_USER_ID };
    const { body } = await run([SAFETENSOR, GGUF]);
    expect(body.fileName).toBe(SAFETENSOR.name);
    expect(urlFileId(body)).toBe(String(SAFETENSOR.id));
  });

  it('preferences never override an explicit modelFileId', async () => {
    currentUser.value = { id: OTHER_USER_ID, filePreferences: GGUF_PREFERENCES };
    const { body } = await run([SAFETENSOR, GGUF], { modelFileId: String(SAFETENSOR.id) });
    expect(body.fileName).toBe(SAFETENSOR.name);
    expect(urlFileId(body)).toBe(String(SAFETENSOR.id));
  });

  it('preferences do NOT reopen the visibility gate for a non-owner', async () => {
    // PRIVATE_MODEL is a perfect match for these preferences too; it must still
    // not be advertised.
    currentUser.value = {
      id: OTHER_USER_ID,
      filePreferences: { ...GGUF_PREFERENCES, format: 'SafeTensor' as const },
    };
    const { body } = await run([PRIVATE_MODEL, SAFETENSOR, GGUF]);
    expect(body.fileName).toBe(SAFETENSOR.name);
    expect(urlFileId(body)).toBe(String(SAFETENSOR.id));
  });
});

describe('GET /api/v1/model-versions/mini/[id] — the training-results/epoch path', () => {
  /**
   * REGRESSION for the visibility gate being applied too early. A Private
   * version's training-results file is non-Public by construction, and its
   * `downloadUrl` is the orchestrator's `epoch.model_url` — it never reaches
   * `/api/download/models/[modelVersionId]`, so the gate's entire justification
   * is absent here. Gating it turns a working epoch url into
   * `404 Missing model file` for every non-owner caller (including those holding
   * an EntityAccess grant).
   */
  it('an anonymous caller still gets the epoch url for a Private version', async () => {
    const { status, body } = await run([TRAINING_FILE], {}, { availability: 'Private' });
    expect(status).toBe(200);
    // The LAST epoch, not the first.
    expect(body.downloadUrls[0]).toBe(EPOCH_URL);
    expect(body.downloadUrls[0]).not.toBe(EARLIER_EPOCH_URL);
    expect(body.fileName).toBe(TRAINING_FILE.name);
    expect(body.hashes.SHA256).toBe(TRAINING_FILE.hashes.SHA256);
  });

  it('an authenticated non-owner still gets the epoch url', async () => {
    currentUser.value = { id: OTHER_USER_ID };
    const { status, body } = await run(
      [TRAINING_FILE, SAFETENSOR],
      { modelFileId: String(TRAINING_FILE.id) },
      { availability: 'Private' }
    );
    expect(status).toBe(200);
    expect(body.downloadUrls[0]).toBe(EPOCH_URL);
    expect(body.fileName).toBe(TRAINING_FILE.name);
  });

  it('the epoch url is the orchestrator url, NOT a download-route url', async () => {
    // The discriminator between the two branches: if the gate ever pushes this
    // file down the download-route path again, the url shape changes even when
    // the response is still a 200.
    const { body } = await run([TRAINING_FILE], {}, { availability: 'Private' });
    expect(body.downloadUrls[0]).not.toContain('/api/download/models/');
    expect(body.downloadUrls[0]).toContain('/jobs/job-abc-123/assets/');
  });

  it('a PUBLIC training-results file on a Public version gets a download-route url, not an epoch url', async () => {
    // Pins the `Private &&` half of the branch condition on a file that IS
    // visible: without it, "training results present" alone would be enough to
    // emit an orchestrator url.
    const { status, body } = await run([PUBLIC_TRAINING_FILE]);
    expect(status).toBe(200);
    expect(body.downloadUrls[0]).not.toContain('/jobs/');
    expect(urlFileId(body)).toBe(String(PUBLIC_TRAINING_FILE.id));
  });

  it("the caller's preferences decide WHICH branch is taken on a Private version", async () => {
    // TRAINING_FILE wins under the defaults (SafeTensor) and would produce an
    // epoch url; GGUF wins for a GGUF-preferring user and is Public, so that
    // caller must get the ordinary download-route url instead. If the branch
    // decision ignored the caller's preferences, this caller would be handed
    // someone else's epoch.
    expect(getPrimaryFile([TRAINING_FILE, GGUF])?.id).toBe(TRAINING_FILE.id);
    expect(getPrimaryFile([TRAINING_FILE, GGUF], { metadata: GGUF_PREFERENCES })?.id).toBe(GGUF.id);

    currentUser.value = { id: OTHER_USER_ID, filePreferences: GGUF_PREFERENCES };
    const { status, body } = await run([TRAINING_FILE, GGUF], {}, { availability: 'Private' });
    expect(status).toBe(200);
    expect(body.fileName).toBe(GGUF.name);
    expect(body.downloadUrls[0]).not.toContain('/jobs/');
    expect(urlFileId(body)).toBe(String(GGUF.id));
  });

  it('a version with NO visible file still 404s — the gate has no ungated fallback', async () => {
    // The download-route path must fail closed. A fallback to the ungated pick
    // would advertise a non-public file's hash/name/size and emit a url the
    // download route answers 404 for.
    const { status, body } = await run([PRIVATE_MODEL]);
    expect(status).toBe(404);
    expect(body).not.toHaveProperty('hashes');
    expect(body).not.toHaveProperty('downloadUrls');
  });

  it('a NON-Private version with a training-results file still uses the download route, and is still gated', async () => {
    // The epoch branch is `Private && trainingResults`. On a Public version the
    // file goes down the download-route path, so the gate still applies and the
    // non-public training file must not be advertised to a non-owner.
    const { body } = await run([TRAINING_FILE, SAFETENSOR]);
    expect(body.fileName).toBe(SAFETENSOR.name);
    expect(urlFileId(body)).toBe(String(SAFETENSOR.id));
  });
});
