import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { nsfwRestrictedBaseModels } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  restrictedBaseModelDivergenceGauge,
  restrictedImageDriftGauge,
  restrictedImageReconcileLastSuccessGauge,
} from '~/server/prom/client';
import { createJob } from './job';

const VERSIONS_PER_CHUNK = 100;

// Sets `Image."modelRestricted"` for images whose resources point at a base model
// listed in `RestrictedBaseModels`. Between 2025-10-16 and this job, nothing
// maintained that column: the read gates in `image.service.ts` kept filtering, so
// pre-October content stayed hidden while everything uploaded since went unflagged.
//
// Hide-only. It never clears the flag, because un-hiding restores content to
// public feeds and that is a moderation decision rather than a reconciliation.
// A consequence worth knowing before you hand-edit the column: a manual `false`
// here is silently re-set on the next run.
//
// It reconciles against the DB table, not against `nsfwRestrictedBaseModels`, so
// restricting a base model stays a deliberate act with a known blast radius rather
// than a side effect of a deploy. The divergence gauge is what keeps the two lists
// from parting company in silence instead.
//
// 🔴 Chunked by model version because the whole-table anti-join is not bounded.
// Measured on the prod replica within one hour on 2026-08-24, same statement:
// 22.4 s, 57.3 s, then two runs that exceeded the bastion path's own ~60 s
// ceiling, so their real duration is unknown and only ">= 60 s" is established.
// That ceiling belongs to the measuring path, not to production — the app connects
// inside the cluster and is not behind it, so do not reason about prod from 60 s.
// `statement_timeout` is 2 min (the database default, which `civitai-app-writer`
// inherits), and a statement already observed spanning 22-57 s does not have the
// headroom to be run hourly unchunked. Per 100 versions it measured 0.7-8.5 s,
// against ~1,712 restricted versions.
export const reconcileRestrictedImages = createJob(
  'reconcile-restricted-images',
  '0 * * * *',
  async (ctx) => {
    const versions = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT mv.id
      FROM "RestrictedBaseModels" rbm
      JOIN "ModelVersion" mv ON mv."baseModel" = rbm."baseModel"
      ORDER BY mv.id
    `;

    let flagged = 0;
    const chunks = chunk(
      versions.map((v) => v.id),
      VERSIONS_PER_CHUNK
    );
    for (const ids of chunks) {
      ctx.checkIfCanceled();
      flagged += await dbWrite.$executeRaw`
        UPDATE "Image" i
        SET "modelRestricted" = true
        WHERE i."modelRestricted" IS DISTINCT FROM true
          AND i.id IN (
            SELECT irn."imageId"
            FROM "ImageResourceNew" irn
            WHERE irn."modelVersionId" IN (${Prisma.join(ids)})
          )
      `;
    }

    const rows = await dbWrite.$queryRaw<{ baseModel: string }[]>`
      SELECT "baseModel" FROM "RestrictedBaseModels"
    `;
    const inDb = new Set(rows.map((r) => r.baseModel));
    const inCode = new Set<string>(nsfwRestrictedBaseModels);
    const missingInDb = [...inCode].filter((bm) => !inDb.has(bm));
    const missingInCode = [...inDb].filter((bm) => !inCode.has(bm));

    restrictedImageDriftGauge.set(flagged);
    restrictedBaseModelDivergenceGauge.set({ direction: 'missing_in_db' }, missingInDb.length);
    restrictedBaseModelDivergenceGauge.set({ direction: 'missing_in_code' }, missingInCode.length);
    restrictedImageReconcileLastSuccessGauge.set(Math.floor(Date.now() / 1000));

    if (flagged > 0 || missingInDb.length > 0 || missingInCode.length > 0) {
      await logToAxiom(
        {
          name: 'reconcile-restricted-images',
          type: 'warning',
          message: 'Restricted-image drift found',
          flagged,
          missingInDb,
          missingInCode,
          versions: versions.length,
        },
        'webhooks'
      );
    }

    return { flagged, missingInDb, missingInCode, versions: versions.length };
  },
  { lockExpiration: 30 * 60 }
);
