import { Prisma, VaultItemStatus } from '@prisma/client';
import JSZip, { file } from 'jszip';
import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { getModelVersionDataForVault } from '~/server/services/vault.service';
import { htmlToPdf } from '~/server/utils/pdf-helpers';
import { getCustomPutUrl, getGetUrlByKey } from '~/utils/s3-utils';
import { env } from 'process';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { fetchBlob } from '~/utils/file-utils';
import { constants } from '~/server/common/constants';
import { withRetries } from '~/server/utils/errorHandling';
import { VaultItemMetadataSchema } from '../schema/vault.schema';

const MAX_FAILURES = 3;

export const processVaultItems = createJob('process-vault-items', '1 * * * *', async () => {
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
            equals: Prisma.JsonNull,
          },
        },
      ],
    },
  });

  for (const vaultItem of vaultItems) {
    try {
      // Get model version info:
      const { detail, images } = await getModelVersionDataForVault({
        modelVersionId: vaultItem.modelVersionId,
      });

      // Now, prepare the PDF file:
      const pdfFile = await htmlToPdf(detail);
      const zip = new JSZip();
      let coverImage: { data: Blob; filename: string };
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
          {
            url: coverImageUploadUrl,
            data: coverImage.data,
            headers: { 'Content-Type': 'image/*' },
          },
        ].map((upload) =>
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
          status: VaultItemStatus.Stored,
        },
      });
    } catch (e) {
      console.error('Error processing vault item:', e);
      const meta = (vaultItem.meta ?? { failures: 0 }) as VaultItemMetadataSchema;

      await dbWrite.vaultItem.update({
        where: { id: vaultItem.id },
        data: {
          status: VaultItemStatus.Failed,
          meta: {
            ...meta,
            failures: meta.failures + 1,
          },
        },
      });

      continue;
    }
  }
});
