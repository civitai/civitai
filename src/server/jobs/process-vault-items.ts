import { Prisma, VaultItemStatus } from '@prisma/client';
import JSZip from 'jszip';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { env } from '~/env/server.mjs';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { vaultItemFailedCounter, vaultItemProcessedCounter } from '~/server/prom/client';
import { getModelVersionDataForVault } from '~/server/services/vault.service';
import { withRetries } from '~/server/utils/errorHandling';
import { getModelVersionDetailsPDF } from '~/server/utils/pdf-helpers';
import { fetchBlob } from '~/utils/file-utils';
import { getCustomPutUrl } from '~/utils/s3-utils';
import { isDefined } from '~/utils/type-guards';
import { VaultItemMetadataSchema } from '../schema/vault.schema';
import { createJob, getJobDate } from './job';

const MAX_FAILURES = 3;

const logErrors = (data: MixedObject) => {
  logToAxiom({ name: 'process-vault-items', type: 'error', ...data }, 'webhooks').catch();
};

export const processVaultItems = createJob('process-vault-items', '*/10 * * * *', async () => {
  const [, setLastRun] = await getJobDate('process-vault-items');

  if (!env.S3_VAULT_BUCKET) {
    throw new Error('S3_VAULT_BUCKET is not defined');
  }

  const vaultItems = await dbWrite.vaultItem.findMany({
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
  });

  for (const vaultItem of vaultItems) {
    try {
      // Get model version info:
      const { modelVersion, images } = await getModelVersionDataForVault({
        modelVersionId: vaultItem.modelVersionId,
      });

      // Now, prepare the PDF file:
      const pdfFile = await getModelVersionDetailsPDF(modelVersion);
      const zip = new JSZip();

      let coverImage: { data: Blob; filename: string } | undefined;

      await Promise.all(
        images.map(async (img, idx) => {
          try {
            const imageUrl = getEdgeUrl(img.url, { type: img.type });
            const blob = await fetchBlob(imageUrl);
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
        })
      );

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

      const { url: detailsUploadUrl } = await getCustomPutUrl(env.S3_VAULT_BUCKET, keys.details);
      const { url: imagesUploadUrl } = await getCustomPutUrl(env.S3_VAULT_BUCKET, keys.images);
      const { url: coverImageUploadUrl } = await getCustomPutUrl(
        env.S3_VAULT_BUCKET,
        keys.coverImage
      );

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

      const meta = (vaultItem.meta ?? { failures: 0 }) as VaultItemMetadataSchema;

      await dbWrite.vaultItem.update({
        where: { id: vaultItem.id },
        data: {
          status: VaultItemStatus.Failed,
          meta: {
            ...meta,
            failures: meta.failures + 1,
            latestError: error.message,
          },
        },
      });

      continue;
    }
  }

  await setLastRun();
});
