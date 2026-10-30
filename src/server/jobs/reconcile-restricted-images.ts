import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { nsfwRestrictedBaseModels } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  restrictedBaseModelDivergenceGauge,
  restrictedImageDriftGauge,
  restrictedImageOverhiddenGauge,
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
// inherits). Unchunked and with the versions supplied by the join rather than as
// literals, the planner switches to a parallel seq scan of `ImageResourceNew`:
// 440M rows, ~19 GB, 23.8 s. Both properties are load-bearing.
export const reconcileRestrictedImages = createJob(
  'reconcile-restricted-images',
  '0 * * * *',
  async (ctx) => {
    // Read and publish before the chunk loop, so a chunk that times out cannot take
    // the divergence signal down with it. A labelled gauge that is never set does not
    // scrape at all, so an alert on it would go quiet in exactly the state it exists
    // to report.
    const rows = await dbWrite.$queryRaw<{ baseModel: string }[]>`
      SELECT "baseModel" FROM "RestrictedBaseModels"
    `;
    const inDb = new Set(rows.map((r) => r.baseModel));
    const inCode = new Set<string>(nsfwRestrictedBaseModels);
    const missingInDb = [...inCode].filter((bm) => !inDb.has(bm));
    const missingInCode = [...inDb].filter((bm) => !inCode.has(bm));

    restrictedBaseModelDivergenceGauge.set({ direction: 'missing_in_db' }, missingInDb.length);
    restrictedBaseModelDivergenceGauge.set({ direction: 'missing_in_code' }, missingInCode.length);

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
      // 🔴 `EXCEPT` against `idx_image_restricted_true`, not a `modelRestricted`
      // filter on the joined row. Measured on prod, heaviest chunk: the filtered
      // form ran 97,270 random `Image_pkey` probes and 77,699 disk reads (~607 MB,
      // 7,886 ms cold) to produce 521 rows, because the filter is applied after the
      // probe. Two index-only scans do the same work in 924 ms and 17 reads.
      //
      // 🔴 `flagged` must stay the UPDATE's rowcount and must never become the
      // subquery's. 1,016 of 6,640 resource rows for these base models name an image
      // that no longer exists — `ImageResourceNew` has no enforced foreign key — and
      // those ids survive the `EXCEPT` on every run. Counting the read instead would
      // give the drift gauge a permanent floor and it would never reach the zero
      // that `prom/client.ts` calls healthy.
      flagged += await dbWrite.$executeRaw`
        UPDATE "Image" i
        SET "modelRestricted" = true
        WHERE i."modelRestricted" IS DISTINCT FROM true
          AND i.id IN (
            SELECT irn."imageId"
            FROM "ImageResourceNew" irn
            WHERE irn."modelVersionId" IN (${Prisma.join(ids)})
            EXCEPT
            SELECT id FROM "Image" WHERE "modelRestricted" = true
          )
      `;
    }

    // Reported, never acted on. This is also the recovery query if a model owner
    // ever sets a version's base model to a restricted value and back: `baseModel`
    // is owner-settable on a published version, so the flag can be applied to other
    // people's images, and nothing un-hides them. Measured 2.7 s on the prod replica.
    const [{ count: overhidden }] = await dbWrite.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
      FROM "Image" i
      WHERE i."modelRestricted" = true
        AND NOT EXISTS (
          SELECT 1
          FROM "ImageResourceNew" irn
          JOIN "ModelVersion" mv ON mv.id = irn."modelVersionId"
          JOIN "RestrictedBaseModels" rbm ON rbm."baseModel" = mv."baseModel"
          WHERE irn."imageId" = i.id
        )
    `;

    restrictedImageDriftGauge.set(flagged);
    restrictedImageOverhiddenGauge.set(Number(overhidden));
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
          overhidden: Number(overhidden),
          versions: versions.length,
        },
        'webhooks'
      );
    }

    return {
      flagged,
      overhidden: Number(overhidden),
      missingInDb,
      missingInCode,
      versions: versions.length,
    };
  },
  { lockExpiration: 30 * 60 }
);
