import { Prisma } from '@prisma/client';
import { lowerFirst } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import * as z from 'zod';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { dbWrite } from '~/server/db/client';
import {
  getShouldChargeForResources,
  resolveCanGenerateForVersions,
} from '~/server/services/generation/generation.service';
import { getFeaturedModels } from '~/server/services/model.service';
import type { GenerationAlias } from '~/server/schema/model-version.schema';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import { getEpochJobAndFileName, getPrimaryFile } from '~/server/utils/model-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import type {
  LicensingFeeSettlementCurrency,
  LicensingFeeType,
  ModelType,
  ModelHashType,
  ModelUsageControl,
} from '~/shared/utils/prisma/enums';
import { Availability } from '~/shared/utils/prisma/enums';
import { stringifyAIR } from '~/shared/utils/air';
import { Flags } from '~/shared/utils/flags';
import { UserFlag } from '~/shared/constants/user-flags.constants';
import { ModelVersionFlag } from '~/shared/constants/model-version-flags.constants';

export const schema = z.object({
  // Bound to Postgres int4 (the `ModelVersion.id` column type, max 2147483647).
  // Same overflow class as GET /api/v1/models/[id]: a bare `z.coerce.number()`
  // accepts an out-of-range numeric string that then binds to the int4 `mv.id`
  // in the raw query below and throws PG "value out of range for type integer"
  // → raw 500. `.int().gt(0)` fails safeParse for out-of-range/non-positive ids
  // → the existing 400 path fires. (The `if (!id)` guard below still covers a
  // legitimately absent id.)
  id: z.coerce.number().int().gt(0).lte(2147483647),
  epoch: z.number().optional(),
  // When supplied, the response describes that exact ModelFile (download url,
  // hashes, size, AIR with `+<fileId>`) rather than the version's primary file.
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
  generationAlias?: GenerationAlias | null;
  freeTrialLimit?: number;
  minor: boolean;
  sfwOnly: boolean;
  usageControl: ModelUsageControl;
  modelUserId: number;
  licensingFee: number | null;
  licensingFeeType: LicensingFeeType | null;
  licensingFeeSettlementCurrency: LicensingFeeSettlementCurrency | null;
  isLicensingRoot: boolean;
  licensingSourceVersionId: number | null;
  sourceLicensingFeeRecipientUserId: number | null;
  sourceLicensingFee: number | null;
  sourceLicensingFeeType: LicensingFeeType | null;
  sourceLicensingFeeSettlementCurrency: LicensingFeeSettlementCurrency | null;
  versionFlags: number;
  userFlags: number;
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
};

export default MixedAuthEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  const results = schema.safeParse(req.query);
  if (!results.success)
    return res.status(400).json({ error: z.prettifyError(results.error) ?? 'Invalid id' });

  const { id } = results.data;
  if (!id) return res.status(400).json({ error: 'Missing modelVersionId' });
  const where = [Prisma.sql`mv.id = ${id}`];
  if (!user?.isModerator)
    where.push(Prisma.sql`(mv.status = 'Published' OR m."userId" = ${user?.id})`);

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
      mv."earlyAccessEndsAt",
      mv."requireAuth",
      mv."usageControl",
      mv."licensingFee"::float8 AS "licensingFee",
      mv."licensingFeeType",
      mv."licensingFeeSettlementCurrency",
      (lr.id IS NOT NULL) AS "isLicensingRoot",
      mv."licensingSourceVersionId",
      lsm."userId" AS "sourceLicensingFeeRecipientUserId",
      lsv."licensingFee"::float8 AS "sourceLicensingFee",
      lsv."licensingFeeType" AS "sourceLicensingFeeType",
      lsv."licensingFeeSettlementCurrency" AS "sourceLicensingFeeSettlementCurrency",
      mv."flags" AS "versionFlags",
      u."flags" AS "userFlags",
      (
        (
            (mv."earlyAccessEndsAt" > NOW() OR mv."earlyAccessPermanent")
            AND mv."availability" = 'EarlyAccess'
            AND (mv."earlyAccessConfig"->>'freeGeneration' IS NULL OR mv."earlyAccessConfig"->>'freeGeneration' != 'true')
        )
        OR
        (mv."availability" = 'Private')
        OR
        (m."availability" = 'Private')

      ) AS "checkPermission",
      (SELECT covered FROM "GenerationCoverage" WHERE "modelVersionId" = mv.id) AS "covered",
      mv."meta"->'generationAlias' AS "generationAlias",
      (
        CASE
          mv."earlyAccessConfig"->>'chargeForGeneration'
        WHEN 'true'
        THEN
          COALESCE(CAST(mv."earlyAccessConfig"->>'generationTrialLimit' AS int), 10)
        ELSE
          NULL
        END
      ) AS "freeTrialLimit"
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    JOIN "User" u ON u.id = m."userId"
    LEFT JOIN "LicensingRoot" lr ON lr."modelVersionId" = mv.id
    LEFT JOIN "ModelVersion" lsv ON lsv.id = mv."licensingSourceVersionId"
    LEFT JOIN "Model" lsm ON lsm.id = lsv."modelId"
    WHERE ${Prisma.join(where, ' AND ')}
  `;
  if (!modelVersion) return res.status(404).json({ error: 'Model not found' });

  const files = await dbWrite.$queryRaw<FileRow[]>`
    SELECT 
      mf.id, 
      mf.type, 
      mf.visibility, 
      mf.url, 
      mf.metadata, 
      mf."sizeKB", 
      mf.name,
      COALESCE(
        JSON_OBJECT_AGG(mfh.type, mfh.hash) FILTER (WHERE mfh.hash IS NOT NULL),
        '{}'::json
      ) as hashes
    FROM "ModelFile" mf
    LEFT JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id
    WHERE mf."modelVersionId" = ${id}
    GROUP BY mf.id, mf.type, mf.visibility, mf.url, mf.metadata, mf."sizeKB", mf.name
  `;

  const { modelFileId } = results.data;
  // Caller-specified file overrides the version's primary file. Falls back to
  // primary when modelFileId is omitted, preserving legacy behavior.
  const targetFile = modelFileId ? files.find((f) => f.id === modelFileId) : getPrimaryFile(files);
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

  if (modelVersion.availability === Availability.Private && !!targetFile.metadata.trainingResults) {
    const epoch =
      targetFile.metadata.trainingResults.epochs?.find((e) => {
        if ('epoch_number' in e) {
          return e.epoch_number === results.data.epoch;
        }

        return e.epochNumber === results.data.epoch;
      }) ?? targetFile.metadata.trainingResults.epochs?.pop();

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

    air = stringifyAIR({ ...modelVersion, fileId: modelFileId, fileType: targetFile.type });
    downloadUrl = `${baseUrl}${createModelFileDownloadUrl({
      versionId: modelVersion.id,
      fileId: modelFileId,
      primary: !modelFileId,
    })}`;
  }

  // if req url domain contains `api.`, strip /api/ from the download url
  if (req.headers.host?.includes('api.')) {
    downloadUrl = downloadUrl.replace('/api/', '/').replace('civitai.com', 'api.civitai.com');
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
  const canGenerate = genStates.get(modelVersion.id)?.canGenerate ?? false;

  // Check if should charge
  const shouldChargeResult = await getShouldChargeForResources([
    {
      modelType: modelVersion.type,
      modelId: modelVersion.modelId,
      fileSizeKB: targetFile.sizeKB,
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
  const isLicensingRoot =
    modelVersion.isLicensingRoot &&
    modelVersion.licensingFee != null &&
    modelVersion.licensingFee > 0;
  // The recipient's owner is part of each guard: `ModelVersion.modelId` has orphan
  // rows in prod despite a validated FK, and a fee we cannot attribute to a user is
  // worse than no fee — the orchestrator would stamp a null owner onto
  // ResourceCompensation. Dropping the component degrades safely instead.
  const hasSourceRule =
    !isLicensingRoot &&
    modelVersion.licensingSourceVersionId != null &&
    modelVersion.sourceLicensingFee != null &&
    modelVersion.sourceLicensingFee > 0 &&
    modelVersion.sourceLicensingFeeRecipientUserId != null;
  // When the lineage component already settles to this version itself (it's the
  // root), its own fee IS that component — don't double-count it as a surcharge.
  const isBaseRecipientItself = isLicensingRoot;
  const hasOwnFee =
    modelVersion.licensingFee != null && modelVersion.licensingFee > 0 && !isBaseRecipientItself;

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
      amount: modelVersion.licensingFee!,
      type: lowerFirst(modelVersion.licensingFeeType ?? 'PerImageBuzz'),
      settlementCurrency: lowerFirst(modelVersion.licensingFeeSettlementCurrency ?? 'Buzz'),
      recipientModelVersionId: modelVersion.id,
      recipientUserId: modelVersion.modelUserId,
    });
  } else if (hasSourceRule) {
    fees.push({
      role: 'baseModel',
      amount: modelVersion.sourceLicensingFee!,
      type: lowerFirst(modelVersion.sourceLicensingFeeType ?? 'PerImageBuzz'),
      settlementCurrency: lowerFirst(modelVersion.sourceLicensingFeeSettlementCurrency ?? 'Buzz'),
      recipientModelVersionId: modelVersion.licensingSourceVersionId!,
      recipientUserId: modelVersion.sourceLicensingFeeRecipientUserId!,
    });
  }
  if (hasOwnFee) {
    fees.push({
      role: 'version',
      amount: modelVersion.licensingFee!,
      type: lowerFirst(modelVersion.licensingFeeType ?? 'PerImageBuzz'),
      settlementCurrency: lowerFirst(modelVersion.licensingFeeSettlementCurrency ?? 'Buzz'),
      recipientModelVersionId: modelVersion.id,
      recipientUserId: modelVersion.modelUserId,
    });
  }

  const payoutEnabled =
    !Flags.hasFlag(modelVersion.userFlags, UserFlag.DisablePayout) &&
    !Flags.hasFlag(modelVersion.versionFlags, ModelVersionFlag.DisablePayout);

  const data = {
    air,
    versionName: modelVersion.versionName,
    modelName: modelVersion.modelName,
    userId: modelVersion.modelUserId,
    baseModel: modelVersion.baseModel,
    availability: modelVersion.availability,
    publishedAt: modelVersion.publishedAt,
    size: targetFile.sizeKB, // nullable
    fileType: targetFile.type,
    fileName: targetFile.name,
    // nullable - hashes (all available hash types)
    hashes: targetFile.hashes,
    downloadUrls: [downloadUrl], // nullable
    format, // nullable
    canGenerate,
    isFeatured,
    requireAuth: modelVersion.requireAuth,
    checkPermission: modelVersion.checkPermission,
    earlyAccessEndsAt: modelVersion.checkPermission ? modelVersion.earlyAccessEndsAt : undefined,
    freeTrialLimit: modelVersion.checkPermission ? modelVersion.freeTrialLimit : undefined,
    additionalResourceCharge: shouldChargeResult[modelVersion.modelId],
    minor: modelVersion.minor,
    sfwOnly: modelVersion.sfwOnly,
    fees,
    payoutEnabled,
  };
  res.status(200).json(data);
});
