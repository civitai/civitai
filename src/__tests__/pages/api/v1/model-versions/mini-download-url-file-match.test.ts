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
 *   2. `downloadUrl` was emitted as a BARE `/api/download/models/[modelVersionId]`
 *      with no query string — `createModelFileDownloadUrl`'s `primary` flag only
 *      SUPPRESSES the other selectors, and `QS.stringify` has no `primary` key,
 *      so no `primary=true` was ever on the url. A bare url names no file, so
 *      the download route resolves one independently: it re-runs
 *      `getPrimaryFile` itself, over a DIFFERENT population (visibility-filtered)
 *      and with DIFFERENT preferences (the requesting user's `filePreferences`
 *      merged in).
 *
 * On a multi-file version those two picks diverge, and the response then
 * advertises file A's SHA256/size/name next to a URL that serves file B. Any
 * consumer that verifies the hash fails, permanently.
 *
 * The contract pinned here: the URL names the file whose metadata was returned,
 * and the BRANCH (epoch artifact vs civitai file) — which fixes the AIR — does
 * not vary with the caller's preferences.
 */

const {
  mockQueryRaw,
  mockResolveCanGenerateForVersions,
  mockGetShouldChargeForResources,
  mockGetFeaturedModels,
  currentUser,
} = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockResolveCanGenerateForVersions: vi.fn(),
  mockGetShouldChargeForResources: vi.fn(),
  mockGetFeaturedModels: vi.fn(),
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

// MixedAuthEndpoint resolves the (optional) session and passes it as the 3rd
// argument. Swap it for a pass-through that injects whatever `currentUser`
// holds, so the owner/moderator branches are reachable from a test.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, currentUser.value),
}));

import { Air } from '@civitai/client';
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
  metadata: { format: 'SafeTensor', size: 'full', fp: 'fp16' } as const,
  sizeKB: 2_097_152,
  name: 'model-fp16.safetensors',
  hashes: { SHA256: 'A'.repeat(64) },
};
const GGUF = {
  id: 202,
  type: 'Model',
  visibility: 'Public',
  url: 'https://example.invalid/b.gguf',
  metadata: { format: 'GGUF', quantType: 'Q4_K_M' } as const,
  sizeKB: 1_048_576,
  name: 'model-Q4_K_M.gguf',
  hashes: { SHA256: 'B'.repeat(64) },
};
const PRIVATE_MODEL = {
  id: 303,
  type: 'Model',
  visibility: 'Private',
  url: 'https://example.invalid/c.safetensors',
  metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' } as const,
  sizeKB: 4_194_304,
  name: 'private-pruned.safetensors',
  hashes: { SHA256: 'C'.repeat(64) },
};

/**
 * A PUBLIC file whose `ModelFile.type` maps through `fileTypeUrnMap`
 * ('Diffusion Model' -> `diffusionmodel`), unlike every other fixture here
 * (type 'Model', which falls through to the MODEL-type-derived `checkpoint`).
 *
 * That difference is what makes the AIR's `fileType` argument observable. It is
 * scored to LOSE to PRIVATE_MODEL and to be indistinguishable from SAFETENSOR
 * on preferences, so on `[PRIVATE_MODEL, PUBLIC_DIFFUSION]` the two selections
 * genuinely disagree: `requestedFile` (ungated) is PRIVATE_MODEL while
 * `targetFile` (gated) is this file — the exact state a
 * `targetFile.type` -> `requestedFile?.type` mutant would misread.
 */
const PUBLIC_DIFFUSION = {
  id: 606,
  type: 'Diffusion Model',
  visibility: 'Public',
  url: 'https://example.invalid/e.safetensors',
  metadata: { format: 'SafeTensor', size: 'full', fp: 'fp16' } as const,
  sizeKB: 3_145_728,
  name: 'diffusion-fp16.safetensors',
  hashes: { SHA256: 'F'.repeat(64) },
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
    format: 'SafeTensor' as const,
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
  // Deep-clone so a handler that mutates the rows it was handed cannot leak that
  // mutation into the next test through a shared module-level fixture. A real
  // request re-reads the rows from Postgres every time, so an in-place mutation
  // there is invisible in prod and would only ever show up as cross-test
  // contamination here. (The epoch selection used to end in `epochs?.pop()`,
  // which did exactly that; it is now a non-mutating last-element read. The
  // clone stays as the guard against the class, not that one instance.)
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

/**
 * The arguments of the LAST `Air.stringify` call.
 *
 * `src/__tests__/setup.ts` globally stubs `Air.stringify = vi.fn(() => '')`, so
 * `stringifyAIR` returns `''` in every unit suite and `body.air` carries no
 * information — asserting on it can only ever compare `'' === ''`. The stub's
 * ARGUMENTS are fully observable though, and they are precisely what the handler
 * derives from its own state (which branch it took, which file it settled on),
 * so that is the assertable surface. Do NOT "fix" this by unstubbing the module:
 * the stub is global and shared by every unit suite.
 */
function lastAirArgs() {
  return vi.mocked(Air.stringify).mock.calls.at(-1)?.[0];
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
    // `primary` is deliberately NOT in this list: `QS.stringify` is never handed
    // a `primary` key, so asserting its absence guards a string that cannot
    // exist and passes under every mutation. The falsifiable statement is that
    // `fileId` is the ONLY param — assert that instead.
    for (const k of ['type', 'format', 'size', 'fp', 'quantType'])
      expect(params.get(k), `${k} must not be emitted alongside fileId`).toBeNull();
    expect([...params.keys()]).toEqual(['fileId']);
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

  it('the diffusion-model fixture also loses to the private file, and maps to a different AIR type', () => {
    // Makes `[PRIVATE_MODEL, PUBLIC_DIFFUSION]` a population on which the
    // ungated and gated selections disagree...
    expect(getPrimaryFile([PRIVATE_MODEL, PUBLIC_DIFFUSION])?.id).toBe(PRIVATE_MODEL.id);
    expect(getPrimaryFile([PUBLIC_DIFFUSION])?.id).toBe(PUBLIC_DIFFUSION.id);
    // ...and on which `ModelFile.type` is what tells them apart.
    expect(PUBLIC_DIFFUSION.type).not.toBe(PRIVATE_MODEL.type);
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

describe('GET /api/v1/model-versions/mini/[id] — the AIR handed to Air.stringify', () => {
  /**
   * `body.air` is always `''` under the global `Air.stringify` stub, so these
   * assert the stub's ARGUMENTS instead (see `lastAirArgs`). Everything below is
   * a MUTANT GUARD, not regression coverage: the AIR-building code is unchanged
   * by this PR and these pass on both sides of it. They exist because two
   * mutations of it survived the entire suite.
   */
  it('the epoch path names the orchestrator JOB as id and the ASSET as version, not the reverse', async () => {
    const { status } = await run([TRAINING_FILE], {}, { availability: 'Private' });
    expect(status).toBe(200);

    const air = lastAirArgs();
    // Positive control: a zero/undefined here would make every assertion below
    // vacuous, so prove the handler reached `stringifyAIR` at all.
    expect(air, 'stringifyAIR was never called — the assertions below prove nothing').toBeDefined();

    expect(air).toMatchObject({
      source: 'orchestrator',
      id: 'job-abc-123',
      version: 'epoch-000010.safetensors',
    });
    // Operand-order guard. Swapping `modelId: jobId` / `id: fileName` yields a
    // structurally VALID but unresolvable URN, and nothing in the response body
    // changes — only these two assertions can see it.
    expect(air?.id).not.toBe('epoch-000010.safetensors');
    expect(air?.version).not.toBe('job-abc-123');
  });

  it('the download path names the model id and the version id', async () => {
    const { status } = await run([SAFETENSOR, GGUF]);
    expect(status).toBe(200);

    const air = lastAirArgs();
    expect(air).toBeDefined();
    expect(air).toMatchObject({
      source: 'civitai',
      id: String(versionRow.modelId),
      version: String(VERSION_ID),
    });
  });

  it("the AIR type is derived from the ADVERTISED file's type, not the ungated pick's", async () => {
    // `requestedFile` (ungated) is PRIVATE_MODEL, type 'Model' -> `checkpoint`.
    // `targetFile` (gated, and what the response describes) is PUBLIC_DIFFUSION,
    // type 'Diffusion Model' -> `diffusionmodel`. So binding the AIR's
    // `fileType` to `requestedFile?.type` instead of `targetFile.type` is
    // observable here and nowhere else.
    const { status, body } = await run([PRIVATE_MODEL, PUBLIC_DIFFUSION]);
    expect(status).toBe(200);
    expect(body.fileName).toBe(PUBLIC_DIFFUSION.name);
    expect(body.fileType).toBe(PUBLIC_DIFFUSION.type);

    const air = lastAirArgs();
    expect(air).toBeDefined();
    expect(air?.type).toBe('diffusionmodel');
  });

  it("the AIR's fileId is the QUERY PARAM, absent when the caller omitted it", async () => {
    // Pins a deliberate non-change. `fileId` comes from `modelFileId`, not from
    // `targetFile.id`, so a request that omits the param gets an AIR with no
    // `+<fileId>` disambiguator even though the url names a specific file. The
    // two never CONTRADICT each other — when the param is supplied, `targetFile`
    // was looked up by it — the AIR is merely silent. Binding it to
    // `targetFile.id` instead would append `+<fileId>` to essentially every mini
    // response's AIR, and that identifier is logged, cached and handed to the
    // orchestrator. If that is ever wanted, it is its own change with its own
    // blast radius; this test is what makes the drift visible.
    const omitted = await run([SAFETENSOR, GGUF]);
    expect(omitted.status).toBe(200);
    expect(lastAirArgs()?.modelFileId).toBeUndefined();
    // Positive control on the same population: when the param IS supplied the
    // AIR does carry it, so the assertion above is about the param and not about
    // `modelFileId` being unreadable here.
    const supplied = await run([SAFETENSOR, GGUF], { modelFileId: String(GGUF.id) });
    expect(supplied.status).toBe(200);
    expect(lastAirArgs()?.modelFileId).toBe(String(GGUF.id));
    expect(urlFileId(supplied.body)).toBe(String(GGUF.id));
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

  /**
   * The branch selects which KIND of resource the response addresses — an
   * orchestrator epoch artifact or a civitai ModelFile — and that choice fixes
   * the AIR, an identifier that is logged, cached and handed to the
   * orchestrator. A stored per-user preference must not move it: preference
   * answers "which variant do I want", not "which resource is this". (It would
   * also make `?epoch=N` silently a no-op for a caller whose preference happened
   * to steer them off the epoch branch.)
   *
   * So the branch is decided with the DEFAULT preferences, and the caller's
   * preferences are applied only once the download-route arm has been chosen —
   * which the next two cases pin.
   */
  it('the BRANCH is preference-INDEPENDENT — same branch, same AIR, for every caller', async () => {
    // The population is chosen so that preferences WOULD move the pick if they
    // were consulted: TRAINING_FILE wins under the defaults, GGUF wins under
    // GGUF preferences, and only TRAINING_FILE carries training results.
    expect(getPrimaryFile([TRAINING_FILE, GGUF])?.id).toBe(TRAINING_FILE.id);
    expect(getPrimaryFile([TRAINING_FILE, GGUF], { metadata: GGUF_PREFERENCES })?.id).toBe(GGUF.id);

    currentUser.value = { id: OTHER_USER_ID };
    const plain = await run([TRAINING_FILE, GGUF], {}, { availability: 'Private' });
    const plainAir = lastAirArgs();

    currentUser.value = { id: OTHER_USER_ID, filePreferences: GGUF_PREFERENCES };
    const preferring = await run([TRAINING_FILE, GGUF], {}, { availability: 'Private' });
    const preferringAir = lastAirArgs();

    expect(plain.status).toBe(200);
    expect(preferring.status).toBe(200);

    // Same branch: both get the orchestrator epoch url.
    expect(plain.body.downloadUrls[0]).toBe(EPOCH_URL);
    expect(preferring.body.downloadUrls[0]).toBe(EPOCH_URL);
    expect(preferring.body.downloadUrls[0]).not.toContain('/api/download/models/');

    // Same resource described.
    expect(preferring.body.fileName).toBe(plain.body.fileName);
    expect(preferring.body.hashes.SHA256).toBe(plain.body.hashes.SHA256);

    // Same AIR — the whole point. Positive control first, so a pair of
    // `undefined`s cannot satisfy the equality below.
    expect(plainAir).toBeDefined();
    expect(plainAir?.source).toBe('orchestrator');
    expect(preferringAir?.source).toBe('orchestrator');
    expect(preferringAir).toEqual(plainAir);
  });

  it('preferences DO still choose the file on the download-route arm of a Private version', async () => {
    // Same Private version, but the default-preference pick carries no training
    // results, so the branch is the download route — and there the caller's
    // preferences are applied exactly as before, with the url still naming the
    // file whose hash was advertised.
    expect(getPrimaryFile([SAFETENSOR, GGUF])?.id).toBe(SAFETENSOR.id);

    currentUser.value = { id: OTHER_USER_ID, filePreferences: GGUF_PREFERENCES };
    const { status, body } = await run([SAFETENSOR, GGUF], {}, { availability: 'Private' });
    expect(status).toBe(200);
    expect(body.fileName).toBe(GGUF.name);
    expect(body.hashes.SHA256).toBe(GGUF.hashes.SHA256);
    expect(urlFileId(body)).toBe(String(GGUF.id));
    expect(lastAirArgs()?.source).toBe('civitai');
  });

  it('a Private version whose primary file has NO training results stays on the GATED download route', async () => {
    // Pins the `trainingResults` half of `useEpochUrl`. Dropping that conjunct
    // makes `useEpochUrl` true for ANY Private version, which then takes
    // `targetFile = requestedFile` — the UNGATED pick — and, with no training
    // results to follow, falls through to the download-route arm advertising a
    // non-Public file's hash/name/size to a non-owner and emitting a url the
    // download route answers 404 for.
    currentUser.value = { id: OTHER_USER_ID };
    const { status, body } = await run(
      [PRIVATE_MODEL, SAFETENSOR, GGUF],
      {},
      { availability: 'Private' }
    );
    expect(status).toBe(200);
    expect(body.fileName).toBe(SAFETENSOR.name);
    expect(body.hashes.SHA256).toBe(SAFETENSOR.hashes.SHA256);
    expect(urlFileId(body)).toBe(String(SAFETENSOR.id));
    expect(body.downloadUrls[0]).not.toContain('/jobs/');
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
