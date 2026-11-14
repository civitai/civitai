import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import * as z from 'zod';
import { env } from '~/env/server';
import { constants } from '~/server/common/constants';
import { EntityAccessPermission } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import type { VaultItemFilesSchema } from '~/server/schema/vault.schema';
import { hasEntityAccess } from '~/server/services/common.service';
import { getVaultWithStorage } from '~/server/services/vault.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { getDownloadBlocklistValue } from '~/server/services/download-blocklist.service';
import { getTrustedClientIp, parseIpBlocklist } from '~/server/utils/client-ip';
import { isRequestFromBrowser } from '~/server/utils/request-helpers';
import { ModelUsageControl } from '~/shared/utils/prisma/enums';
import { resolveDownloadUrl } from '~/utils/delivery-worker';
import { isModelTakenDown } from '~/server/utils/model-version-gates';
import { resolveActorFor } from '~/utils/resolve-attribution';
import { getGetUrlByKey } from '~/utils/s3-utils';
import {
  checkDownloadCredential,
  DOWNLOAD_SCOPE_REFUSED,
} from '~/server/utils/download-credential-gate';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { getVaultState } from '~/utils/vault';
import { FAILED_SCAN_DOWNLOAD_MESSAGE, hasFailedScan } from '~/server/utils/failed-scan';

const schema = z.object({
  vaultItemId: z.preprocess((val) => Number(val), z.number()),
  type: z.enum(['model', 'images', 'details']),
  fileId: z.coerce.number().optional(),
});

export default AuthedEndpoint(
  async function downloadFromVault(
    req: NextApiRequest,
    res: NextApiResponse,
    sessionUser: SessionUser
  ) {
    const isBrowser = isRequestFromBrowser(req);
    const onError = (status: number, message: string) => {
      res.status(status);
      if (isBrowser) return res.send(message);
      return res.json({ error: message });
    };

    if (!env.S3_VAULT_BUCKET) {
      return onError(500, 'We cannot serve vault downloads at this time.');
    }

    // Get ip so that we can block exploits we catch. Derived via getTrustedClientIp
    // (edge-attested or transport peer only) — an enforcement control must not key
    // on an address the caller supplies. Do not swap this for an inline resolver.
    //
    // Operator note before you add an entry to `ip-blacklist`: a request that did
    // not transit the Cloudflare edge is attributed to the transport peer, so
    // where that peer is a shared hop, listing its address blocks all such
    // traffic to every download route at once rather than one abuser. See
    // `parseIpBlocklist`.
    const ip = getTrustedClientIp(req);
    const ipBlacklist = parseIpBlocklist(await getDownloadBlocklistValue('ip-blacklist'));
    if (ip && ipBlacklist.includes(ip)) return onError(403, 'Forbidden');

    if (!sessionUser) {
      // All vault items require authorization
      return onError(401, 'Unauthorized');
    }
    const credential = await checkDownloadCredential(req, sessionUser, {
      route: '/api/download/vault/[vaultItemId]',
      requiredScope: TokenScope.VaultRead,
    });
    if (credential.refuse) return res.status(403).json(DOWNLOAD_SCOPE_REFUSED);
    const user = credential.effectiveUser ?? sessionUser;

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
      include: { model: { select: { status: true, mode: true } } },
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

    // Unlike a deleted version, a taken-down model's files, images and details are moderators-only,
    // vault included.
    if (modelVersion && isModelTakenDown(modelVersion) && !user.isModerator)
      return onError(404, 'File not found');

    const fileName = `${vaultItem.modelName}-${vaultItem.versionName}`;

    switch (input.type) {
      case 'model': {
        const files = (vaultItem.files ?? []) as VaultItemFilesSchema;
        const file = input.fileId ? files.find((f) => f.id === input.fileId) : files[0];
        if (!file || !file.url) return onError(404, 'File not found');
        if (!user.isModerator) {
          const select = { type: true, pickleScanResult: true, virusScanResult: true } as const;
          // A deleted row's bytes may still be other live rows': judge them by every one of those.
          const own = await dbRead.modelFile.findUnique({ where: { id: file.id }, select });
          const rows = own
            ? [own]
            : await dbRead.modelFile.findMany({ where: { url: file.url }, select });
          if (rows.some(hasFailedScan)) return onError(403, FAILED_SCAN_DOWNLOAD_MESSAGE);
          // Training data is never a vault's file; the site's own rules decide who gets it. With no row
          // left, the name it was stored under (`getFileDisplayName`) still says what it was.
          if (
            rows.length
              ? rows.some((row) => row.type === 'Training Data')
              : file.displayName === 'Training Data'
          )
            return onError(404, 'File not found');
        }
        const { url } = await resolveDownloadUrl(file.id, file.url, file.displayName, {
          caller: 'vault',
          actor: resolveActorFor(user),
        });
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
