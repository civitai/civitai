import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from 'next-auth';
import requestIp from 'request-ip';
import * as z from 'zod';
import { env } from '~/env/server';
import { constants } from '~/server/common/constants';
import { EntityAccessPermission } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import type { VaultItemFilesSchema } from '~/server/schema/vault.schema';
import { hasEntityAccess } from '~/server/services/common.service';
import { getVaultWithStorage } from '~/server/services/vault.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { isRequestFromBrowser } from '~/server/utils/request-helpers';
import { ModelUsageControl } from '~/shared/utils/prisma/enums';
import { resolveDownloadUrl } from '~/utils/delivery-worker';
import { getGetUrlByKey } from '~/utils/s3-utils';
import { getVaultState } from '~/utils/vault';

const schema = z.object({
  vaultItemId: z.preprocess((val) => Number(val), z.number()),
  type: z.enum(['model', 'images', 'details']),
  fileId: z.coerce.number().optional(),
});

export default AuthedEndpoint(
  async function downloadFromVault(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    const isBrowser = isRequestFromBrowser(req);
    const onError = (status: number, message: string) => {
      res.status(status);
      if (isBrowser) return res.send(message);
      return res.json({ error: message });
    };

    if (!env.S3_VAULT_BUCKET) {
      return onError(500, 'We cannot serve vault downloads at this time.');
    }

    // Get ip so that we can block exploits we catch
    const ip = requestIp.getClientIp(req);
    const ipBlacklist = (
      ((await dbRead.keyValue.findUnique({ where: { key: 'ip-blacklist' } }))?.value as string) ??
      ''
    ).split(',');
    if (ip && ipBlacklist.includes(ip)) return onError(403, 'Forbidden');

    // Check if user has a concerning number of downloads
    if (!user) {
      // All vault items require authorization
      return onError(401, 'Unauthorized');
    }

    const userKey = user.id.toString() ?? ip;
    if (!userKey) return onError(403, 'Forbidden');

    // Validate query params

    const queryResults = schema.safeParse(req.query);
    if (!queryResults.success)
      return res
        .status(400)
        .json({ error: z.prettifyError(queryResults.error) ?? 'Invalid vaultItemId' });
    const input = queryResults.data;
    const vaultItemId = input.vaultItemId;
    if (!vaultItemId) return onError(400, 'Missing vaultItemId');

    const userVault = await getVaultWithStorage({ userId: user.id });

    if (!userVault) {
      return onError(404, 'Vault not found');
    }
    const { canDownload } = getVaultState(
      userVault.updatedAt,
      userVault.storageKb,
      userVault.usedStorageKb
    );

    if (!canDownload) {
      return onError(403, 'You cannot download items from your vault at this time.');
    }

    const vaultItem = await dbRead.vaultItem.findUnique({
      where: { id: Number(req.query.vaultItemId), vaultId: user.id },
    });

    if (!vaultItem) return onError(404, 'Vault item not found');

    const modelVersion = await dbRead.modelVersion.findUnique({
      where: { id: vaultItem.modelVersionId },
    });

    const [access] = await hasEntityAccess({
      entityType: 'ModelVersion',
      entityIds: [vaultItem.modelVersionId],
      userId: user.id,
    });

    if (
      // If no model version is found, technically, it was deleted from the site and people with it in Vault CAN access it.
      // This is the whole point of vault.
      modelVersion &&
      (!access ||
        !access.hasAccess ||
        (access.permissions & EntityAccessPermission.EarlyAccessDownload) === 0)
    ) {
      return onError(503, 'You do not have permission to download this model.');
    }

    if (modelVersion && modelVersion?.usageControl !== ModelUsageControl.Download) {
      return onError(503, 'This model does not allow downloads.');
    }

    const fileName = `${vaultItem.modelName}-${vaultItem.versionName}`;

    switch (input.type) {
      case 'model': {
        const files = (vaultItem.files ?? []) as VaultItemFilesSchema;
        const file = input.fileId ? files.find((f) => f.id === input.fileId) : files[0];
        if (!file || !file.url) return onError(404, 'File not found');
        const { url } = await resolveDownloadUrl(file.id, file.url, file.displayName);
        return res.redirect(url);
      }
      case 'images': {
        const key = constants.vault.keys.images
          .replace(':modelVersionId', vaultItem.modelVersionId.toString())
          .replace(':userId', user.id.toString());
        const { url } = await getGetUrlByKey(key, {
          bucket: env.S3_VAULT_BUCKET,
          fileName: `${fileName}-images.zip`,
        });
        return res.redirect(url);
      }
      case 'details': {
        const key = constants.vault.keys.details
          .replace(':modelVersionId', vaultItem.modelVersionId.toString())
          .replace(':userId', user.id.toString());
        const { url } = await getGetUrlByKey(key, {
          bucket: env.S3_VAULT_BUCKET,
          fileName: `${fileName}-details.pdf`,
        });
        return res.redirect(url);
      }
      default: {
        return onError(400, 'Invalid type');
      }
    }
  },
  ['GET']
);
