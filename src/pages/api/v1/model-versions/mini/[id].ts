import { Prisma } from '@prisma/client';
import { isRedCapableHost } from '~/server/utils/server-domain';
import { DEFAULT_GENERATION_TRIAL_LIMIT } from '@civitai/buzz';
import { lowerFirst } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { isNonCommercialBaseModel, stopsCreatorEarnings } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { trainingDataListing } from '~/server/services/training-data-restricted.service';
import {
  getShouldChargeForResources,
  resolveCanGenerateForVersions,
} from '~/server/services/generation/generation.service';
import { getFeaturedModels } from '~/server/services/model.service';
import { coverageColumn, nextCoverageEnabled } from '~/server/services/generation/coverage-source';
import type { GenerationAlias } from '~/server/schema/model-version.schema';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import { CacheTTL } from '~/server/common/constants';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import { logToAxiom } from '~/server/logging/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { matchesOrchestratorServiceToken } from '~/server/auth/orchestrator-service-token';
import {
  refreshBlobsService,
  type BlobRefreshResult,
} from '~/server/services/orchestrator/refreshBlobs';
import { getConsumerBlobId, shouldRefreshBlobUrl } from '~/shared/orchestrator/blob-url';
import { getEpochJobAndFileName, getPrimaryFile } from '~/server/utils/model-helpers';
import { getGenerationFile } from '~/server/utils/resource-air';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import type {
  LicensingFeeSettlementCurrency,
  LicensingFeeType,
  ModelType,
  ModelHashType,
} from '~/shared/utils/prisma/enums';
import {
  Availability,
  ModelFileVisibility,
  type ModelUsageControl,
  type ScanResultCode,
} from '~/shared/utils/prisma/enums';
import { isModelDeleted, isModelTakenDown } from '~/server/utils/model-version-gates';
import {
  getMiniModerationState,
  MINI_MODERATION_EXPIRES_MS,
  moderationBlocksGeneration,
  receivesMiniModeration,
} from '~/server/utils/mini-moderation-state';
import { stringifyAIR } from '~/shared/utils/air';
import { Flags } from '~/shared/utils/flags';
import { apiBrowsingLevel } from '~/server/utils/browsing-level';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { resolveModelFace, showsSfwFace } from '~/shared/utils/model-sfw-face';
import { UserFlag } from '~/shared/constants/user-flags.constants';
import { isCreatorTipEligible } from '~/shared/utils/creator-tip';
import { isEvictable } from '~/shared/constants/model-version-flags.constants';
import { canViewPoiModel } from '~/server/utils/poi-model-visibility';
import { hashRouteServesEveryone } from '~/server/services/download-by-hash.servable';
import {
  credentialKind,
  evaluateMiniEpochCaller,
  getMiniEpochGateMode,
  hasVersionGrant,
} from '~/server/utils/mini-epoch-caller';
import { downloadCredentialGate, scopeRefusalMode } from '~/server/utils/download-credential-gate';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const MINI_ROUTE = '/api/v1/model-versions/mini/[id]';
const MINI_SCOPES = { anyOfScopes: [TokenScope.ModelsRead, TokenScope.AIServicesRead] };

export const schema = z.object({
  // Bound to Postgres int4 (the `ModelVersion.id` column type, max 2147483647).
  // Same overflow class as GET /api/v1/models/[id]: a bare `z.coerce.number()`
  // accepts an out-of-range numeric string that then binds to the int4 `mv.id`
  // in the raw query below and throws PG "value out of range for type integer"
  // → raw 500. `.int().gt(0)` fails safeParse for out-of-range/non-positive ids
  // → the existing 400 path fires. (The `if (!id)` guard below still covers a
  // legitimately absent id.)
  id: z.coerce.number().int().gt(0).lte(2147483647),
  epoch: z.coerce.number().int().optional(),
  // When supplied, the response describes that exact ModelFile (download url,
  // hashes, size, AIR with `+<fileId>`) rather than the version's generation file.
  modelFileId: z.coerce.number().int().positive().optional(),
});

type VersionRow = {
  id: number;
  versionName: string;
  availability: Availability;
  publishedAt: Date | null;
  modelId: number;
  modelName: string;
  baseModel: BaseModel;
  status: string;
  type: ModelType;
  earlyAccessEndsAt?: Date;
  requireAuth: boolean;
  checkPermission: boolean;
  covered?: boolean;
  coveredLive?: boolean;
  isPromoted: boolean;
  generationAlias?: GenerationAlias | null;
  freeTrialLimit?: number;
  minor: boolean;
  sfwOnly: boolean;
  usageControl: ModelUsageControl;
  modelUserId: number;
  modelStatus: string;
  modelMode: string | null;
  modelAvailability: Availability;
  poi: boolean;
  licensingFee: number | null;
  licensingFeeType: LicensingFeeType | null;
  licensingFeeSettlementCurrency: LicensingFeeSettlementCurrency | null;
  isLicensingRoot: boolean;
  licensingSourceVersionId: number | null;
  sourceLicensingFeeRecipientUserId: number | null;
  sourceModelType: string | null;
  sourceBaseModel: string | null;
  sourceLicensingFee: number | null;
  sourceLicensingFeeType: LicensingFeeType | null;
  sourceLicensingFeeSettlementCurrency: LicensingFeeSettlementCurrency | null;
  versionFlags: number;
  userFlags: number;
  ownerDeletedAt: Date | null;
  ownerBannedAt: Date | null;
  nsfwLevel: number;
  sfwName: string | null;
  modelDeletedAt: Date | null;
};
type FileRow = {
  id: number;
  type: string;
  visibility: string;
  url: string;
  metadata: FileMetadata;
  sizeKB: number;
  name: string;
  hashes: Record<ModelHashType, string>;
  replacedAt: Date | null;
  pickleScanResult: ScanResultCode | null;
  virusScanResult: ScanResultCode | null;
};

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  sessionUser: Session['user'] | undefined
) {
  // The orchestrator's service token carries no user and keeps its own path.
  const orchestrator = matchesOrchestratorServiceToken(req);
  const credential = orchestrator
    ? { outcome: 'session' as const, effectiveUser: sessionUser }
    : downloadCredentialGate(req, sessionUser, MINI_SCOPES);
  // Read only where the answer depends on it, so the flag and its log see the epoch arm alone.
  let scopeRefused: Promise<boolean> | undefined;
  const isScopeRefused = () =>
    (scopeRefused ??=
      credential.outcome === 'refused'
        ? scopeRefusalMode(req, MINI_ROUTE, MINI_SCOPES).then((mode) => mode === 'enforce')
        : Promise.resolve(false));
  // A credential the scope gate refuses carries no moderator rights here either.
  const user =
    credential.effectiveUser?.isModerator && (await isScopeRefused())
      ? { ...credential.effectiveUser, isModerator: false }
      : credential.effectiveUser;

  const results = schema.safeParse(req.query);
  if (!results.success)
    return res.status(400).json({ error: z.prettifyError(results.error) ?? 'Invalid id' });

  const { id } = results.data;
  if (!id) return res.status(400).json({ error: 'Missing modelVersionId' });
  const where = [Prisma.sql`mv.id = ${id}`];
  // An owner's own credential sees its own version row even when the scope gate refuses it.
  if (!user?.isModerator)
    where.push(Prisma.sql`(mv.status = 'Published' OR m."userId" = ${user?.id})`);

  // 🔴 NO audience here. The ORCHESTRATOR reads this endpoint with no user to decide what it may
  // load (see the coverage flag in flipt/client.ts), so deriving membership from the caller
  // would answer `member: false` to it and refuse the expansion for everyone, members included.
  const coverage = Prisma.raw(`"${coverageColumn(await nextCoverageEnabled())}"`);

  const [modelVersion] = await dbWrite.$queryRaw<VersionRow[]>`
    SELECT
      mv.id,
      mv.name as "versionName",
      mv."modelId",
      m.name as "modelName",
      mv."baseModel",
      mv.status,
      mv.availability,
      mv."publishedAt",
      m.type,
      m.minor,
      m."sfwOnly",
      m."userId" as "modelUserId",
      m.status as "modelStatus",
      m.mode as "modelMode",
      m.availability as "modelAvailability",
      m.poi,
      m."deletedAt" AS "modelDeletedAt",
      mv."nsfwLevel",
      m."sfwName",
      pa."endsAt" AS "earlyAccessEndsAt",
      mv."requireAuth",
      mv."usageControl",
      mv."licensingFee"::float8 AS "licensingFee",
      mv."licensingFeeType",
      mv."licensingFeeSettlementCurrency",
      (lr.id IS NOT NULL) AS "isLicensingRoot",
      mv."licensingSourceVersionId",
      lsm."userId" AS "sourceLicensingFeeRecipientUserId",
      lsm."type" AS "sourceModelType",
      lsv."baseModel" AS "sourceBaseModel",
      lsv."licensingFee"::float8 AS "sourceLicensingFee",
      lsv."licensingFeeType" AS "sourceLicensingFeeType",
      lsv."licensingFeeSettlementCurrency" AS "sourceLicensingFeeSettlementCurrency",
      mv."flags" AS "versionFlags",
      u."flags" AS "userFlags",
      u."deletedAt" AS "ownerDeletedAt",
      u."bannedAt" AS "ownerBannedAt",
      (
        (
            pa."entityId" IS NOT NULL
            AND (pa."endsAt" IS NULL OR pa."endsAt" > NOW())
            AND (pa."terms"->'generation'->>'free' IS NULL OR pa."terms"->'generation'->>'free' != 'true')
        )
        OR
        (mv."availability" = 'Private')
        OR
        (m."availability" = 'Private')

      ) AS "checkPermission",
      -- 🔴 The column is chosen by the flag, because this is what the ORCHESTRATOR reads to decide
      -- whether a resource can generate, and prepareResource refuses anything it believes cannot.
      -- On the live rule paid model loading cannot load the very checkpoints it exists for --
      -- verified 2026-09-08 on version 3040959: covered by the staged rule, not the live one, and
      -- the estimate failed with the orchestrator's "not enabled for generation". Turning the flag
      -- off must therefore close this surface too, or the orchestrator keeps loading community
      -- checkpoints the site has stopped offering.
      -- See docs/features/paid-model-loading-coverage.md.
      -- Both columns off ONE evaluation of the view: a second scalar subquery re-runs the whole
      -- view body (its three IN-lists, the ModelFile aggregate) against the PRIMARY pool, per
      -- resource per submit -- measured at +58% buffers on this query.
      gc.${coverage} AS "covered",
      -- isGenerationEligible holds a locked ecosystem's checkpoints to the live rule.
      gc."covered" AS "coveredLive",
      -- Auction winners, for the orchestrator to prioritise their downloads. It does not read this yet.
      EXISTS (
        SELECT 1 FROM "CoveredCheckpoint" cc
        WHERE cc.model_id = mv."modelId" AND cc.version_id = mv.id
      ) AS "isPromoted",
      mv."meta"->'generationAlias' AS "generationAlias",
      (
        CASE
          -- A paid generation tier is a generation grant that is NOT free (its price is optional and
          -- falls back to the download price), mirroring paidGenerationGrant().
          WHEN pa."terms"->'generation' IS NOT NULL
            AND COALESCE(pa."terms"->'generation'->>'free', '') <> 'true'
        THEN
          COALESCE(CAST(pa."terms"->'generation'->>'trialLimit' AS int), ${DEFAULT_GENERATION_TRIAL_LIMIT})::int
        ELSE
          NULL
        END
      ) AS "freeTrialLimit"
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    JOIN "User" u ON u.id = m."userId"
    LEFT JOIN "PaidAccess" pa ON pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
    LEFT JOIN "LicensingRoot" lr ON lr."modelVersionId" = mv.id
    LEFT JOIN "ModelVersion" lsv ON lsv.id = mv."licensingSourceVersionId"
    LEFT JOIN "Model" lsm ON lsm.id = lsv."modelId"
    LEFT JOIN LATERAL (
      SELECT "covered", "coveredNext" FROM "GenerationCoverage" WHERE "modelVersionId" = mv.id
    ) gc ON TRUE
    WHERE ${Prisma.join(where, ' AND ')}
  `;
  // Same answer as an unknown id, so the response does not reveal that the version exists.
  if (!modelVersion || !canViewPoiModel(modelVersion.poi, modelVersion.modelUserId, user))
    return res.status(404).json({ error: 'Model not found' });

  // Above SFW, unrated, or with a civitai.com name, the answer depends on the caller's region, which
  // the shared cache does not key on.
  const withinSfw =
    !!modelVersion.nsfwLevel && Flags.hasFlag(sfwBrowsingLevelsFlag, modelVersion.nsfwLevel);
  if (!withinSfw || modelVersion.sfwName != null)
    res.setHeader('Cache-Control', 'private, no-store');
  // A restricted region is served the levels /api/v1/model-versions/[id] serves it (unrated fails
  // closed), with the civitai.com name. The orchestrator, on its verified service token, is exempt:
  // it is not a viewer in a region.
  const servedLevel = orchestrator ? allBrowsingLevelsFlag : apiBrowsingLevel(req);
  if (
    servedLevel !== allBrowsingLevelsFlag &&
    !Flags.intersects(modelVersion.nsfwLevel, servedLevel)
  )
    return res.status(404).json({ error: 'Model not found' });
  const modelName = resolveModelFace(
    { name: modelVersion.modelName, sfwName: modelVersion.sfwName },
    showsSfwFace(servedLevel)
  ).name;

  const files = await dbWrite.$queryRaw<FileRow[]>`
    SELECT 
      mf.id, 
      mf.type, 
      mf.visibility, 
      mf.url, 
      mf.metadata, 
      mf."sizeKB", 
      mf.name,
      mf."replacedAt",
      mf."pickleScanResult",
      mf."virusScanResult",
      COALESCE(
        JSON_OBJECT_AGG(mfh.type, mfh.hash) FILTER (WHERE mfh.hash IS NOT NULL),
        '{}'::json
      ) as hashes
    FROM "ModelFile" mf
    LEFT JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id
    WHERE mf."modelVersionId" = ${id}
    GROUP BY mf.id, mf.type, mf.visibility, mf.url, mf.metadata, mf."sizeKB", mf.name, mf."replacedAt",
      mf."pickleScanResult", mf."virusScanResult"
    -- requestedFile below calls the bare getPrimaryFile, which settles a full tie by input order,
    -- and that choice decides the epoch branch. (getGenerationFile does its own id sort.)
    ORDER BY mf.id
  `;

  const { modelFileId } = results.data;

  // Visibility gate, mirroring `getFileForModelVersion` (the download route this
  // endpoint's `downloadUrl` points at): owners and moderators see every file of
  // the version, everyone else only Public ones. The raw query above does NOT
  // filter visibility, so without this the endpoint could advertise a non-public
  // file's hash/name/size — and now that the url names that exact file, the
  // download route would answer 404 for it.
  //
  // 🔴 The gate constrains ONLY the path that delegates to the download route.
  // The training-results/epoch branch below builds `downloadUrl` from the
  // orchestrator (`epoch.model_url`) and never touches
  // /api/download/models/[modelVersionId], so the justification above simply
  // does not apply to it — and a Private version's training file is non-Public
  // by construction, so gating it would turn a working epoch url into
  // `404 Missing model file` for every non-owner caller (including holders of an
  // EntityAccess grant). Hence: resolve the caller's target over the UNFILTERED
  // population first (this is exactly the pre-existing resolution), decide which
  // url shape applies, and only then apply the gate to the download-route path.
  const isOwner = !!user?.id && user.id === modelVersion.modelUserId;
  const isMod = !!user?.isModerator;
  // A credential the scope gate refuses sees only what anyone may.
  const viewerManages = (isOwner || isMod) && !(await isScopeRefused());
  const listed = await trainingDataListing(dbRead, [{ id, files }], {
    redCapable: isRedCapableHost(req.headers.host),
    viewerManages,
  });
  const visibleFiles = files.filter(
    (f) => (viewerManages || f.visibility === ModelFileVisibility.Public) && listed(f)
  );

  // The download route merges the requesting user's `filePreferences` into
  // `getPrimaryFile` (see `getFileForModelVersion` in file.service.ts). Pinning
  // the url to a `fileId` took that merge out of the loop, so the endpoint has to
  // apply the preferences itself or a caller's format/size/fp choice is silently
  // dropped. (The download route also merges explicit `format`/`size`/`fp`/
  // `quantType` query params; this endpoint accepts none of those.)
  //
  // 🔴 …but ONLY on the download-route arm. The branch below selects which KIND
  // of resource this response addresses — an orchestrator epoch artifact vs a
  // civitai ModelFile — and that choice determines the AIR, a shared identifier
  // that is logged, cached and handed to the orchestrator. It must not vary per
  // caller: a preference answers "which variant do I want", not "which resource
  // is this". So the branch is decided with the DEFAULT preferences and is
  // identical for every caller; the caller's preferences are applied only once
  // the download-route arm has been chosen. Hash/url consistency is unaffected —
  // `targetFile` still governs both on that arm.
  const filePreferences = { metadata: user?.filePreferences };

  // Owner, moderator, grantee or the service token, with a credential that passes the scope gate.
  // The scope is checked last, so the refusal log counts only callers it would change.
  let entitledToVersion: Promise<boolean> | undefined;
  const isEntitled = () =>
    (entitledToVersion ??= (async () =>
      orchestrator ||
      ((isOwner || isMod || (!!user?.id && (await hasVersionGrant(user.id, modelVersion.id)))) &&
        !(await isScopeRefused())))());

  // A file id the caller may not see is answered as one that does not exist, decided before the
  // file is looked up so the answer cannot tell the two apart.
  if (modelFileId && !visibleFiles.some((f) => f.id === modelFileId)) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!(await isEntitled()))
      return res
        .status(404)
        .json({ error: `Model file ${modelFileId} not found in version ${id}` });
  }

  // `getPrimaryFile` over the unfiltered files with default preferences, deliberately — see both
  // notes above; this only decides `useEpochUrl` and, on the epoch arm, names the training file.
  const requestedFile = modelFileId
    ? files.find((f) => f.id === modelFileId)
    : getPrimaryFile(files);
  // The primary file the caller may not see is logged as its own reason, so the gate's measurement
  // counts it separately.
  const hiddenPrimary = !modelFileId && (!requestedFile || !visibleFiles.includes(requestedFile));

  const useEpochUrl =
    modelVersion.availability === Availability.Private && !!requestedFile?.metadata.trainingResults;

  // Only the owner, a moderator, a grantee or the service token gets a freshly signed url; anyone
  // else the gate serves (`log`, or `enforce-anon` with a credential) keeps the stored one.
  let mayResign = false;
  // Decided before the epoch is read, so a refused caller gets the same answer whatever the
  // version's training results hold.
  if (useEpochUrl) {
    const mode = await getMiniEpochGateMode();
    if (mode !== 'off') {
      // The body now depends on the caller, so no shared cache may hold it.
      res.setHeader('Cache-Control', 'private, no-store');
      const caller = await evaluateMiniEpochCaller({
        req,
        user,
        modelVersionId: modelVersion.id,
        ownerId: modelVersion.modelUserId,
        mode,
        scopeRefused: await isScopeRefused(),
        pick: modelFileId ? 'by-id' : hiddenPrimary ? 'hidden-primary' : 'primary',
      });
      // Answered as an unknown id. The no-store above stays, so a shared cache cannot hand this
      // 404 to a caller who would be served.
      if (caller.withhold) return res.status(404).json({ error: 'Model not found' });
      mayResign = caller.callerClass !== 'anonymous' && caller.callerClass !== 'other';
    } else {
      mayResign =
        orchestrator ||
        ((user?.id === modelVersion.modelUserId || !!user?.isModerator) &&
          !(await isScopeRefused()));
    }
  }

  const targetFile = useEpochUrl
    ? requestedFile
    : modelFileId
    ? visibleFiles.find((f) => f.id === modelFileId)
    : getGenerationFile(visibleFiles, filePreferences);
  if (!targetFile) {
    return res.status(404).json({
      error: modelFileId
        ? `Model file ${modelFileId} not found in version ${id}`
        : 'Missing model file',
    });
  }

  const baseUrl = getBaseUrl();
  let air: string;
  let downloadUrl: string;

  // `useEpochUrl` already implies `targetFile === requestedFile` and that it
  // carries `trainingResults`; reading the field back here is purely so the type
  // narrows for the block below.
  const trainingResults = useEpochUrl ? targetFile.metadata.trainingResults : undefined;

  if (trainingResults) {
    const epoch =
      trainingResults.epochs?.find((e) => {
        if ('epoch_number' in e) {
          return e.epoch_number === results.data.epoch;
        }

        return e.epochNumber === results.data.epoch;
      }) ??
      // Non-mutating last-element read. `epochs?.pop()` would MUTATE the
      // metadata object this handler was handed, and it is the only reader here
      // that does; `model-version.service.ts` already expresses the same
      // "latest epoch" selection as `epochs?.[epochs.length - 1]`. Consolidated
      // on the non-mutating form.
      trainingResults.epochs?.[trainingResults.epochs.length - 1];

    if (!epoch) {
      return res.status(404).json({ error: 'Missing epoch' });
    }

    downloadUrl = 'epoch_number' in epoch ? epoch.model_url : epoch.modelUrl;
    const { jobId, fileName } = getEpochJobAndFileName(downloadUrl)!;

    if (!jobId || !fileName) {
      return res.status(404).json({ error: 'Could not get jobId or fileName' });
    }

    air = stringifyAIR({
      ...modelVersion,
      source: 'orchestrator',
      modelId: jobId,
      id: fileName,
    });
  } else {
    // this does not work for things like Flux
    // if (targetFile.type !== 'Model') return res.status(404).json({ error: 'File is not a model' });

    // `fileId` is the QUERY PARAM, deliberately — not `targetFile.id`. The two
    // agree whenever the caller supplied one (`targetFile` was looked up BY that
    // id); when the caller omitted it the AIR simply carries no `+<fileId>`
    // disambiguator, so it under-specifies rather than contradicting the url.
    // Switching it to `targetFile.id` would append `+<fileId>` to the AIR of
    // every mini response that omits the param — i.e. essentially all of them —
    // and the AIR is a shared identifier that is logged, cached and handed to
    // the orchestrator. That is a deliberate non-change here; see the
    // AIR-arguments test that pins the current shape both ways.
    air = stringifyAIR({ ...modelVersion, fileId: modelFileId, fileType: targetFile.type });
    // Pin the url to the file this response actually describes. What this
    // replaced was a BARE `/api/download/models/[modelVersionId]` with no query
    // string at all (`createModelFileDownloadUrl`'s `primary` flag only
    // SUPPRESSES the other selectors — `QS.stringify` has no `primary` key, so
    // none was ever emitted). A bare url names no file, so
    // /api/download/models/[modelVersionId] resolves one independently: it
    // re-runs `getPrimaryFile` over a different population (visibility-filtered)
    // with different preferences (the requesting user's `filePreferences`) — so
    // on a multi-file version the url could serve a file other than the one
    // whose hash/size/name is returned here, and any consumer verifying the hash
    // fails.
    downloadUrl = `${baseUrl}${createModelFileDownloadUrl({
      versionId: modelVersion.id,
      fileId: targetFile.id,
    })}`;
  }

  const downloadUrls = [downloadUrl];
  const sha256 = targetFile.hashes.SHA256;
  // Anything else would lead with a url that refuses where the id url serves.
  const hashRouteServes = hashRouteServesEveryone({
    fileVisibility: targetFile.visibility,
    pickleScanResult: targetFile.pickleScanResult,
    virusScanResult: targetFile.virusScanResult,
    versionStatus: modelVersion.status,
    versionAvailability: modelVersion.availability,
    usageControl: modelVersion.usageControl,
    modelStatus: modelVersion.modelStatus,
    modelMode: modelVersion.modelMode,
    modelAvailability: modelVersion.modelAvailability,
    poi: modelVersion.poi,
  });
  if (
    !trainingResults &&
    hashRouteServes &&
    sha256 &&
    // A scan that never ran writes 64 zeros, which every such file would share.
    !/^0+$/.test(sha256) &&
    (await isFlipt(FLIPT_FEATURE_FLAGS.DOWNLOAD_HASH_URLS, String(targetFile.id)))
  )
    downloadUrls.unshift(`${baseUrl}/api/download/sha256/${sha256.toLowerCase()}`);

  // if req url domain contains `api.`, strip /api/ from the download url
  if (req.headers.host?.includes('api.')) {
    for (const [i, url] of downloadUrls.entries())
      downloadUrls[i] = url.replace('/api/', '/').replace('civitai.com', 'api.civitai.com');
  }
  const { format } = targetFile.metadata;

  const genStates = await resolveCanGenerateForVersions(
    [
      {
        id: modelVersion.id,
        status: modelVersion.status,
        availability: modelVersion.availability,
        usageControl: modelVersion.usageControl,
        baseModel: modelVersion.baseModel,
        covered: modelVersion.covered ?? false,
        coveredLive: modelVersion.coveredLive ?? false,
        modelUserId: modelVersion.modelUserId,
        modelType: modelVersion.type,
        flags: modelVersion.versionFlags,
        modelVersionAlias: modelVersion.generationAlias,
      },
    ],
    {
      user: { id: user?.id, isModerator: user?.isModerator },
      sfwOnly: false,
      wildcardsEnabled: false,
    }
  );
  const moderation = getMiniModerationState({
    versionStatus: modelVersion.status,
    versionAvailability: modelVersion.availability,
    modelStatus: modelVersion.modelStatus,
    modelMode: modelVersion.modelMode,
    modelAvailability: modelVersion.modelAvailability,
    poi: modelVersion.poi,
    modelDeletedAt: modelVersion.modelDeletedAt,
    ownerDeletedAt: modelVersion.ownerDeletedAt,
    ownerBannedAt: modelVersion.ownerBannedAt,
  });
  const canGenerate =
    !moderationBlocksGeneration(moderation) &&
    (genStates.get(modelVersion.id)?.canGenerate ?? false);

  // Check if should charge
  const shouldChargeResult = await getShouldChargeForResources([
    {
      modelType: modelVersion.type,
      modelId: modelVersion.modelId,
      fileSizeKB: targetFile.sizeKB,
      versionFlags: modelVersion.versionFlags,
    },
  ]);

  const isFeatured = (await getFeaturedModels())
    .map((fm) => fm.modelId)
    .includes(modelVersion.modelId);

  // Licensing-fee resolution (per resource). One "base/lineage" component — the
  // fee owed to the licensor of whatever this version derives from — plus an
  // optional "version" surcharge the creator stacks on top; each settles to its
  // own recipient. `fees` carries the full breakdown; the orchestrator charges
  // the sum and pays out each entry separately. The base/lineage component is
  // resolved most-specific first:
  //   1. this version is a LicensingRoot (a row in the LicensingRoot table) ->
  //      its own fee IS the lineage fee, settled to itself (e.g. an ecosystem's
  //      Turbo checkpoint charges its rate, not the base's).
  //   2. licensingSourceVersionId set -> the chosen root's fee, settled to it
  //      (a checkpoint built on Turbo inherits the Turbo rate).
  //   Otherwise there is no lineage fee — a null source is NOT a fallback to a
  //   (baseModel, modelType) default; derivatives carry an explicit parent.
  const nonCommercial = isNonCommercialBaseModel(modelVersion.baseModel);
  const earningsStopped = stopsCreatorEarnings(modelVersion.baseModel);
  const isLicensingRoot =
    !nonCommercial &&
    modelVersion.isLicensingRoot &&
    modelVersion.licensingFee != null &&
    modelVersion.licensingFee > 0;
  // The recipient's owner is part of each guard: `ModelVersion.modelId` has orphan
  // rows in prod despite a validated FK, and a fee we cannot attribute to a user is
  // worse than no fee — the orchestrator would stamp a null owner onto
  // ResourceCompensation. Dropping the component degrades safely instead.
  const hasSourceRule =
    !nonCommercial &&
    !isNonCommercialBaseModel(modelVersion.sourceBaseModel) &&
    !isLicensingRoot &&
    modelVersion.licensingSourceVersionId != null &&
    modelVersion.sourceLicensingFee != null &&
    modelVersion.sourceLicensingFee > 0 &&
    modelVersion.sourceLicensingFeeRecipientUserId != null;
  // When the lineage component already settles to this version itself (it's the
  // root), its own fee IS that component — don't double-count it as a surcharge.
  const isBaseRecipientItself = isLicensingRoot;
  const hasOwnFee =
    !nonCommercial &&
    modelVersion.licensingFee != null &&
    modelVersion.licensingFee > 0 &&
    !isBaseRecipientItself;

  // `recipientUserId` is the owner of `recipientModelVersionId` at request time, so
  // payouts and the orchestrator's ResourceCompensation records follow ownership
  // transfers instead of crediting a past owner.
  const fees: Array<{
    role: 'baseModel' | 'version';
    amount: number;
    type: string;
    settlementCurrency: string;
    recipientModelVersionId: number;
    recipientUserId: number;
  }> = [];
  if (isLicensingRoot) {
    fees.push({
      role: 'baseModel',
      amount: modelVersion.licensingFee ?? 0,
      type: lowerFirst(modelVersion.licensingFeeType ?? 'PerImageBuzz'),
      settlementCurrency: lowerFirst(modelVersion.licensingFeeSettlementCurrency ?? 'Buzz'),
      recipientModelVersionId: modelVersion.id,
      recipientUserId: modelVersion.modelUserId,
    });
  } else if (hasSourceRule) {
    fees.push({
      role: 'baseModel',
      amount: modelVersion.sourceLicensingFee ?? 0,
      type: lowerFirst(modelVersion.sourceLicensingFeeType ?? 'PerImageBuzz'),
      settlementCurrency: lowerFirst(modelVersion.sourceLicensingFeeSettlementCurrency ?? 'Buzz'),
      recipientModelVersionId: modelVersion.licensingSourceVersionId!,
      recipientUserId: modelVersion.sourceLicensingFeeRecipientUserId!,
    });
  }
  if (hasOwnFee) {
    fees.push({
      role: 'version',
      amount: modelVersion.licensingFee ?? 0,
      type: lowerFirst(modelVersion.licensingFeeType ?? 'PerImageBuzz'),
      settlementCurrency: lowerFirst(modelVersion.licensingFeeSettlementCurrency ?? 'Buzz'),
      recipientModelVersionId: modelVersion.id,
      recipientUserId: modelVersion.modelUserId,
    });
  }

  // Only a fee that is actually charged opts a version out of creator comp; a stored fee that isn't
  // charged must not also cost the creator comp. The lineage fee (hasSourceRule) settles to a
  // different creator, so it doesn't opt THIS one out.
  const payoutEnabled =
    !earningsStopped &&
    !Flags.hasFlag(modelVersion.userFlags, UserFlag.DisablePayout) &&
    !(isLicensingRoot || hasOwnFee);
  // Independent of the fee: a fee creator still gets their share of the creator tip.
  const tipsEnabled =
    !earningsStopped &&
    isCreatorTipEligible({
      ownerId: modelVersion.modelUserId,
      ownerFlags: modelVersion.userFlags,
    });

  // An epoch url is the orchestrator's own link to the weights, outside the download route's
  // gates: a deleted or taken-down model's is moderators-only, as its files are.
  const gated = {
    status: modelVersion.status,
    model: { status: modelVersion.modelStatus, mode: modelVersion.modelMode },
  };
  const withholdEpochUrl =
    !!trainingResults && !user?.isModerator && (isModelDeleted(gated) || isModelTakenDown(gated));

  // The stored url was signed once, at publish, and is signed again here for a caller it is served
  // to. Each refresh also extends the blob's life on the orchestrator, so never for a withheld url.
  const blobId =
    trainingResults && mayResign && !withholdEpochUrl
      ? getConsumerBlobId(downloadUrls[0])
      : undefined;
  if (blobId) {
    const resigned = await resignEpochBlob(modelVersion.modelUserId, blobId, !!user?.isModerator);
    // A blocked blob is never served; a missing one is, until the stored url expires.
    if (
      resigned.status === 'gone' &&
      (resigned.reason !== 'missing' || shouldRefreshBlobUrl(downloadUrls[0]))
    )
      return res.status(404).json({ error: 'Missing epoch' });
    if (resigned.status === 'refreshed') {
      res.setHeader('Cache-Control', 'private, no-store');
      downloadUrls[0] = resigned.url;
    } else
      logToAxiom({
        type: 'warning',
        name:
          resigned.status === 'gone'
            ? 'mini-epoch-resign-gone-unexpired'
            : 'mini-epoch-blob-resign',
        message: 'served the stored epoch url',
        modelVersionId: modelVersion.id,
        fileId: targetFile.id,
        blobId,
      }).catch(() => undefined);
  }

  const includeModeration = receivesMiniModeration(req, user);
  const data = {
    air,
    defaultFileId: getGenerationFile(files)?.id ?? null,
    versionName: modelVersion.versionName,
    modelName,
    userId: modelVersion.modelUserId,
    baseModel: modelVersion.baseModel,
    availability: modelVersion.availability,
    publishedAt: modelVersion.publishedAt,
    size: targetFile.sizeKB, // nullable
    fileType: targetFile.type,
    fileName: targetFile.name,
    // nullable - hashes (all available hash types)
    hashes: targetFile.hashes,
    downloadUrls: withholdEpochUrl ? [] : downloadUrls, // nullable
    format, // nullable
    canGenerate,
    isFeatured,
    isPromoted: modelVersion.isPromoted,
    // Computed, not written to the flag, so the pin lifts by itself when the promotion ends.
    evictable: !modelVersion.isPromoted && isEvictable(modelVersion.versionFlags),
    requireAuth: modelVersion.requireAuth,
    checkPermission: modelVersion.checkPermission,
    earlyAccessEndsAt: modelVersion.checkPermission ? modelVersion.earlyAccessEndsAt : undefined,
    freeTrialLimit: modelVersion.checkPermission ? modelVersion.freeTrialLimit : undefined,
    additionalResourceCharge: shouldChargeResult[modelVersion.modelId],
    minor: modelVersion.minor,
    sfwOnly: modelVersion.sfwOnly,
    fees,
    payoutEnabled,
    tipsEnabled,
    ...(includeModeration ? { moderation } : {}),
  };
  logMiniModerationCaller(req, user, modelVersion, includeModeration);
  if (includeModeration) {
    res.setHeader('Cache-Control', 'private, no-store');
    // Read by the orchestrator as the absolute time its cached copy of this response expires.
    res.setHeader('X-Expires', new Date(Date.now() + MINI_MODERATION_EXPIRES_MS).toISOString());
  }
  res.status(200).json(data);
});

/** Logs which principal the request's credential resolves to. */
function logMiniModerationCaller(
  req: NextApiRequest,
  user: Session['user'] | undefined,
  { id: modelVersionId, modelUserId: ownerId }: { id: number; modelUserId: number },
  moderationIncluded: boolean
) {
  const orchestrator = matchesOrchestratorServiceToken(req);
  const resolvedAs = credentialKind(req, user, orchestrator);
  if (resolvedAs === 'none') return;
  const principal = user?.isModerator
    ? 'moderator'
    : orchestrator
    ? 'orchestrator-token'
    : user?.id && user.id === ownerId
    ? 'owner'
    : 'other';
  logToAxiom({
    type: 'info',
    name: 'mini-moderation-caller',
    modelVersionId,
    resolvedAs,
    principal,
    moderationIncluded,
  }).catch(() => undefined);
}

const RESIGN_TIMEOUT_MS = 3000;

/**
 * A fresh signature from the blob owner's own orchestrator account; `unknown` on any failure. Only a
 * refreshed url is cached, so a refusal (a blocked blob above all) is asked again on the next read.
 */
async function resignEpochBlob(
  ownerId: number,
  blobId: string,
  moderator: boolean
): Promise<BlobRefreshResult> {
  const unknown: BlobRefreshResult = { blobId, status: 'unknown' };
  const key = `${REDIS_KEYS.CACHES.EPOCH_BLOB_RESIGNED_URL}:${ownerId}:${blobId}` as const;
  const controller = new AbortController();
  const resign = async (): Promise<BlobRefreshResult> => {
    const cached = await redis.packed.get<string>(key).catch(() => null);
    if (cached && !shouldRefreshBlobUrl(cached))
      return { blobId, status: 'refreshed', url: cached };
    const token = await getOrchestratorToken(ownerId, undefined, { bypassCache: moderator });
    const [result] = await refreshBlobsService({
      token,
      blobIds: [blobId],
      signal: controller.signal,
    });
    if (result?.status === 'refreshed')
      void redis.packed.set(key, result.url, { EX: CacheTTL.xs * 5 }).catch(() => undefined);
    return result ?? unknown;
  };
  return withTimeoutFallback(
    resign().catch(() => unknown),
    RESIGN_TIMEOUT_MS,
    unknown,
    () => controller.abort()
  );
}
