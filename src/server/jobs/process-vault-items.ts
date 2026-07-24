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

const logErrors = (data: MixedObject) => {
  logToAxiom({ name: 'process-vault-items', type: 'error', ...data }, 'webhooks').catch();
};

// Eligible = Pending/Failed items that have not yet exhausted their retry budget.
// An item whose `failures` has climbed past MAX_FAILURES is excluded here so a
// permanently-failing (e.g. repeatedly-OOMing) item eventually stops being retried.
export const getEligibleVaultItemsQuery = () => ({
  where: {
    status: {
      in: [VaultItemStatus.Pending, VaultItemStatus.Failed],
    },
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
  take: VAULT_ITEMS_BATCH_SIZE,
});

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
  await dbWrite.vaultItem.update({
    where: { id: vaultItem.id },
    data: {
      meta: { ...meta, failures: priorFailures + 1 },
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
        meta: { ...meta, failures: priorFailures },
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
    await processVaultItem(vaultItem, { s3, bucket: env.S3_VAULT_BUCKET });
  }

  await setLastRun();
});
