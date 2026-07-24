import { Prisma } from '@prisma/client';
import { VaultItemStatus } from '~/shared/utils/prisma/enums';
import JSZip from 'jszip';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { env } from '~/env/server';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { vaultItemFailedCounter, vaultItemProcessedCounter } from '~/server/prom/client';
import { getModelVersionDataForVault } from '~/server/services/vault.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { withRetries } from '~/server/utils/errorHandling';
import { getModelVersionDetailsPDF } from '~/server/utils/pdf-helpers';
import { fetchBlob } from '~/utils/file-utils';
import { getCustomPutUrl, getS3Client } from '~/utils/s3-utils';
import { isDefined } from '~/utils/type-guards';
import type { VaultItemMetadataSchema } from '../schema/vault.schema';
import { createJob, getJobDate } from './job';

export const MAX_FAILURES = 3;
// Bound how many items a single run pulls + processes. The heavy per-item work
// (download every gallery image into memory, then build the whole zip in memory)
// makes an unbounded backlog an OOM risk, so cap the run like the sibling vault
// job (clear-vault-items also uses batches of 50).
export const VAULT_ITEMS_BATCH_SIZE = 50;
// Cap simultaneous image downloads/buffers per item. The previous unbounded
// Promise.all buffered every image of a gallery into memory at once — a large
// gallery alone could exceed the container memory limit.
export const IMAGE_DOWNLOAD_CONCURRENCY = 5;
// Per-upload S3 PUT timeout. The S3 uploads (details PDF + images zip + optional
// cover) previously had NO timeout, so a hung upstream could park an item for
// undici's ~300s default PER attempt AND — via withRetries — across multiple
// attempts, making a single item's wall-clock runtime effectively unbounded and
// able to outlive the lease (see LEASE_STALENESS_MS). Bounding each PUT with an
// AbortSignal.timeout makes the worst case computable. 60s is generous for an
// internal S3 PUT of a details PDF or a ≤10-image zip; a slower-than-that upload
// is aborted and retried by withRetries rather than hanging indefinitely.
export const VAULT_UPLOAD_TIMEOUT_MS = 60 * 1000; // 60 seconds
// A run stamps each item it starts with a `processingStartedAt` lease timestamp
// (see processVaultItem). The scheduler can start a new run before the previous
// one finishes — a run is allowed to outlast the cron interval. Without a guard,
// two overlapping runs both do the heavy download+zip work on the SAME item and
// last-writer-wins on the meta blob, losing failure-count updates and duplicating
// the very work the batch cap exists to bound. Excluding freshly-leased items from
// the eligibility query prevents that overlap. The lease is advisory only: a run
// killed mid-item (e.g. OOM) can never clear its lease, so a lease older than this
// staleness window is treated as abandoned and the item becomes eligible again.
//
// This window must comfortably exceed the now-BOUNDED worst-case per-item runtime,
// so a legit-slow item never ages out mid-run and gets re-claimed (which would
// re-introduce the exact double-process / lost-update the lease prevents). The
// lease is stamped at the START of each item (not at batch fetch), so only ONE
// item's runtime matters here. Worst-case per item (all inputs at their caps):
//   - image downloads: images are capped at 10/version (vault.service
//     `imagesPerVersion: 10`), fetched at IMAGE_DOWNLOAD_CONCURRENCY=5 with a
//     300s fetchBlob timeout each → ceil(10/5) × 300s = 2 waves × 5 min = 10 min
//   - PDF + in-memory zip generation (bounded by the 10-image cap)     ≈  2 min
//   - S3 uploads: 3 blobs in parallel, each withRetries(3) → worst-case
//     4 attempts × VAULT_UPLOAD_TIMEOUT_MS (60s) = 240s = 4 min wall (parallel)
//   ---------------------------------------------------------------------------
//   worst-case per-item runtime ≈ 16 min
// 45 min gives a comfortable ~2.8× margin (16 min << 45 min) so a still-working
// run is never pre-empted; a pathological run that somehow exceeds even 45 min can
// at worst be double-processed, still strictly better than the no-guard behavior.
export const LEASE_STALENESS_MS = 45 * 60 * 1000; // 45 minutes (see worst-case math above)

const logErrors = (data: MixedObject) => {
  logToAxiom({ name: 'process-vault-items', type: 'error', ...data }, 'webhooks').catch();
};

// Eligible = Pending/Failed items that have not yet exhausted their retry budget.
// An item whose `failures` has climbed past MAX_FAILURES is excluded here so a
// permanently-failing (e.g. repeatedly-OOMing) item eventually stops being retried.
export const getEligibleVaultItemsQuery = () => {
  // Items leased more recently than this are assumed to be actively in-flight in
  // another (overlapping) run and are skipped; older leases are treated as
  // abandoned. Computed per call so each run measures staleness from "now".
  const leaseCutoff = Date.now() - LEASE_STALENESS_MS;
  return {
    where: {
      status: {
        in: [VaultItemStatus.Pending, VaultItemStatus.Failed],
      },
      // Both guards must hold (AND). Kept as an explicit AND of two OR-groups so
      // the top-level `status` filter and each guard compose unambiguously.
      AND: [
        // Retry-budget guard: an item whose `failures` has climbed past
        // MAX_FAILURES is excluded so a permanently-failing (e.g. repeatedly
        // -OOMing) item eventually stops being retried. A missing `failures`
        // (never attempted) is treated as within budget.
        {
          OR: [
            {
              meta: {
                path: ['failures'],
                lte: MAX_FAILURES,
              },
            },
            {
              meta: {
                path: ['failures'],
                equals: Prisma.AnyNull,
              },
            },
          ],
        },
        // Overlap guard: skip items a concurrent run is (probably) still working
        // on — i.e. leased within the staleness window. An absent/null lease, or
        // a stale one (older than the window, so its run was likely killed),
        // stays eligible. ISO/string comparison is avoided by storing the lease
        // as epoch millis so this is a plain numeric JSON-path filter (mirrors
        // the `failures` filter above, which is a proven-working pattern here).
        {
          OR: [
            // JSON-path null semantics this design HINGES on: `path +
            // equals: Prisma.AnyNull` matches rows where the key is ABSENT inside
            // a non-null `meta` blob (SQL `jsonb #> path IS NULL`), so never-leased
            // items AND legacy items predating this field stay eligible — they are
            // NOT stranded out of the backlog. This is the same pattern a prod
            // billing job relies on: process-subscriptions-requiring-renewal.ts
            // uses `metadata: { path: ['renewalEmailSent'], equals: Prisma.AnyNull }`
            // to select rows whose renewal-email key is absent. Do NOT "simplify"
            // this to an explicit-null-only check on a Prisma upgrade — that would
            // silently exclude every absent-key row and freeze the backlog.
            {
              meta: {
                path: ['processingStartedAt'],
                equals: Prisma.AnyNull,
              },
            },
            {
              meta: {
                path: ['processingStartedAt'],
                lt: leaseCutoff,
              },
            },
          ],
        },
      ],
    },
    take: VAULT_ITEMS_BATCH_SIZE,
  };
};

type VaultItemRow = Awaited<ReturnType<typeof dbWrite.vaultItem.findMany>>[number];
type ProcessContext = {
  s3: Awaited<ReturnType<typeof getS3Client>>;
  bucket: string;
};

export async function processVaultItem(vaultItem: VaultItemRow, ctx: ProcessContext) {
  const { s3, bucket } = ctx;
  const meta = (vaultItem.meta ?? { failures: 0 }) as VaultItemMetadataSchema;
  const priorFailures = meta.failures ?? 0;

  // OOM-resilient failure accounting: persist an attempt marker BEFORE the heavy
  // download+zip work. A hard OOMKill (SIGKILL) during that work never runs the
  // catch block below, so without this pre-increment the item's failure count
  // would never advance and it would be retried on every run forever (an infinite
  // OOM loop). By recording the attempt up front, a repeatedly-killing item climbs
  // to MAX_FAILURES and drops out of getEligibleVaultItemsQuery(). A successful run
  // rolls this back (see the Stored update), so normal semantics are unchanged.
  //
  // This same write claims the item for this run by stamping `processingStartedAt`
  // (epoch millis). getEligibleVaultItemsQuery() excludes items with a fresh lease,
  // so an overlapping run started before this one finishes won't re-process the
  // same item. Both terminal paths below clear the lease; a run killed here (OOM)
  // leaves it set, and it ages out after LEASE_STALENESS_MS.
  await dbWrite.vaultItem.update({
    where: { id: vaultItem.id },
    data: {
      meta: { ...meta, failures: priorFailures + 1, processingStartedAt: Date.now() },
    },
  });

  try {
    // Get model version info:
    const { modelVersion, images } = await getModelVersionDataForVault({
      modelVersionId: vaultItem.modelVersionId,
    });

    // Now, prepare the PDF file:
    const pdfFile = await getModelVersionDetailsPDF(modelVersion);
    const zip = new JSZip();

    let coverImage: { data: Blob; filename: string } | undefined;

    // Bounded-concurrency download: only IMAGE_DOWNLOAD_CONCURRENCY images are
    // buffered into memory at any one time instead of the whole gallery at once.
    const imageTasks = images.map((img, idx) => async () => {
      try {
        const imageUrl = getEdgeUrl(img.url, { type: img.type });
        const blob = await fetchBlob(imageUrl, 300_000);
        const filename = img.name ?? imageUrl.split('/').pop();

        if (filename && blob) {
          if (idx === 0) {
            coverImage = { data: blob, filename: `cover.${filename?.split('.').pop()}` };
          }
          const arrayBuffer = await blob.arrayBuffer();
          zip.file(filename, arrayBuffer);
        }
      } catch (e) {
        console.error('Error fetching image:', e);
      }
    });
    await limitConcurrency(imageTasks, IMAGE_DOWNLOAD_CONCURRENCY);

    const imagesZip = await zip.generateAsync({ type: 'blob' });

    // Upload these to S3:
    // Upload the PDF:
    const keys = {
      details: constants.vault.keys.details
        .replace(':modelVersionId', vaultItem.modelVersionId.toString())
        .replace(':userId', vaultItem.vaultId.toString()),
      images: constants.vault.keys.images
        .replace(':modelVersionId', vaultItem.modelVersionId.toString())
        .replace(':userId', vaultItem.vaultId.toString()),
      //  TODO: might wanna change the extension here, but we'll see.
      coverImage: constants.vault.keys.cover
        .replace(':modelVersionId', vaultItem.modelVersionId.toString())
        .replace(':userId', vaultItem.vaultId.toString()),
    };

    const { url: detailsUploadUrl } = await getCustomPutUrl(bucket, keys.details, s3);
    const { url: imagesUploadUrl } = await getCustomPutUrl(bucket, keys.images, s3);
    const { url: coverImageUploadUrl } = await getCustomPutUrl(bucket, keys.coverImage, s3);

    await Promise.all(
      [
        { url: detailsUploadUrl, data: pdfFile, headers: { 'Content-Type': 'application/pdf' } },
        { url: imagesUploadUrl, data: imagesZip, headers: { 'Content-Type': 'application/zip' } },
        !!coverImage
          ? {
              url: coverImageUploadUrl,
              data: coverImage.data,
              headers: { 'Content-Type': 'image/*' },
            }
          : undefined,
      ]
        .filter(isDefined)
        .map((upload) =>
          withRetries(() =>
            fetch(upload.url, {
              method: 'PUT',
              body: upload.data,
              headers: {
                ...upload.headers,
              },
              // Bound each PUT so a hung upstream can't make this item outlive its
              // lease (see VAULT_UPLOAD_TIMEOUT_MS / LEASE_STALENESS_MS). A timeout
              // aborts this attempt and withRetries retries rather than hanging.
              signal: AbortSignal.timeout(VAULT_UPLOAD_TIMEOUT_MS),
            })
          )
        )
    );

    // If everything above went out smoothly, the user can now download the files from the vault.
    await dbWrite.vaultItem.update({
      where: { id: vaultItem.id },
      data: {
        // Update with the actual zip size:
        imagesSizeKb: imagesZip.size / 1024,
        detailsSizeKb: pdfFile.size / 1024,
        status: VaultItemStatus.Stored,
        // Roll back the optimistic pre-attempt increment: a successful run must
        // not count against the retry budget (preserves prior success semantics).
        // Clear the in-flight lease now that this run is done with the item.
        meta: { ...meta, failures: priorFailures, processingStartedAt: null },
      },
    });
    vaultItemProcessedCounter.inc();
  } catch (e) {
    const error = e as Error;
    await logErrors({
      message: 'Error processing vault item',
      error: error.message,
      vaultItem,
    });
    vaultItemFailedCounter.inc();

    // The failure was already counted before the heavy work (the pre-increment
    // above), so we re-assert the same count here rather than incrementing again —
    // that keeps exactly one failure per failed run, matching the prior behavior,
    // while still marking latestError + the Failed status on the catchable path.
    await dbWrite.vaultItem.update({
      where: { id: vaultItem.id },
      data: {
        status: VaultItemStatus.Failed,
        meta: {
          ...meta,
          failures: priorFailures + 1,
          latestError: error.message,
          // Clear the in-flight lease: this run has finished with the item, so a
          // caught failure is retried on the next cycle rather than waiting out
          // the staleness window.
          processingStartedAt: null,
        },
      },
    });
  }
}

export const processVaultItems = createJob('process-vault-items', '*/10 * * * *', async () => {
  const [, setLastRun] = await getJobDate('process-vault-items');

  if (!env.S3_VAULT_BUCKET) {
    throw new Error('S3_VAULT_BUCKET is not defined');
  }

  const vaultItems = await dbWrite.vaultItem.findMany(getEligibleVaultItemsQuery());

  const s3 = await getS3Client();
  for (const vaultItem of vaultItems) {
    // Per-item isolation: one item's failure must never abort the whole batch.
    // processVaultItem has its own try/catch around the heavy work, but the
    // pre-attempt increment (and the catch-path bookkeeping write) run OUTSIDE
    // it — a transient DB blip on that single update-by-PK would otherwise
    // propagate out of this loop and skip every remaining item. Log and continue
    // to the next item, matching the pre-existing "catch per item and move on"
    // behavior.
    try {
      await processVaultItem(vaultItem, { s3, bucket: env.S3_VAULT_BUCKET });
    } catch (e) {
      const error = e as Error;
      await logErrors({
        message: 'Unhandled error processing vault item; skipping to next',
        error: error?.message,
        vaultItem,
      });
    }
  }

  await setLastRun();
});
