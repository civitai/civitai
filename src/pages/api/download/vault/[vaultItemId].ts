import { NextApiRequest, NextApiResponse } from 'next';
import requestIp from 'request-ip';
import { z } from 'zod';
import { env } from '~/env/server.mjs';
import { constants } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { VaultItemFilesSchema } from '~/server/schema/vault.schema';
import { getVaultWithStorage } from '~/server/services/vault.service';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { RateLimitedEndpoint } from '~/server/utils/rate-limiting';
import { isRequestFromBrowser } from '~/server/utils/request-helpers';
import { getDownloadUrl } from '~/utils/delivery-worker';
import { getGetUrlByKey } from '~/utils/s3-utils';
import { getVaultState } from '~/utils/vault';

const schema = z.object({
  vaultItemId: z.preprocess((val) => Number(val), z.number()),
  type: z.enum(['model', 'images', 'details']),
  fileId: z.coerce.number().optional(),
});

export default RateLimitedEndpoint(
  async function downloadFromVault(req: NextApiRequest, res: NextApiResponse) {
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

    // Check if user is blacklisted
    const session = await getServerAuthSession({ req, res });
    if (!!session?.user) {
      const userBlacklist = (
        ((await dbRead.keyValue.findUnique({ where: { key: 'user-blacklist' } }))
          ?.value as string) ?? ''
      ).split(',');
      if (userBlacklist.includes(session.user.id.toString())) return onError(403, 'Forbidden');
    }

    // Check if user has a concerning number of downloads
    if (!session?.user) {
      // All vault items require authorization
      return onError(401, 'Unauthorized');
    }

    const userKey = session?.user.id.toString() ?? ip;
    if (!userKey) return onError(403, 'Forbidden');

    // Validate query params

    const queryResults = schema.safeParse(req.query);
    if (!queryResults.success)
      return res
        .status(400)
        .json({ error: `Invalid id: ${queryResults.error.flatten().fieldErrors.vaultItemId}` });
    const input = queryResults.data;
    const vaultItemId = input.vaultItemId;
    if (!vaultItemId) return onError(400, 'Missing vaultItemId');

    const userVault = await getVaultWithStorage({ userId: session?.user.id });

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
      where: { id: Number(req.query.vaultItemId), vaultId: session?.user.id },
    });

    if (!vaultItem) return onError(404, 'Vault item not found');

    const fileName = `${vaultItem.modelName}-${vaultItem.versionName}`;

    switch (input.type) {
      case 'model': {
        const files = (vaultItem.files ?? []) as VaultItemFilesSchema;
        const file = input.fileId ? files.find((f) => f.id === input.fileId) : files[0];
        if (!file || !file.url) return onError(404, 'File not found');
        const { url } = await getDownloadUrl(file.url);
        return res.redirect(url);
      }
      case 'images': {
        const key = constants.vault.keys.images
          .replace(':modelVersionId', vaultItem.modelVersionId.toString())
          .replace(':userId', session?.user.id.toString());
        const { url } = await getGetUrlByKey(key, {
          bucket: env.S3_VAULT_BUCKET,
          fileName: `${fileName}-images.zip`,
        });
        return res.redirect(url);
      }
      case 'details': {
        const key = constants.vault.keys.details
          .replace(':modelVersionId', vaultItem.modelVersionId.toString())
          .replace(':userId', session?.user.id.toString());
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
  ['GET'],
  'download-vault-item'
);
