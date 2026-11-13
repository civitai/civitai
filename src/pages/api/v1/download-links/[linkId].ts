import type { NextApiRequest, NextApiResponse } from 'next';
import { logToAxiom, safeError } from '~/server/logging/client';
import { resolveDownloadLinkMinter } from '~/server/services/download-link/download-link-minter';
import { isLinkToken, revokeLink } from '~/server/services/download-link/download-link.store';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/** Revokes one download link. Only the credential that minted it may; any other gets a 404. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const minter = await resolveDownloadLinkMinter(req);
    if (!minter.ok)
      return res
        .status(minter.status)
        .json({ error: minter.status === 401 ? 'Unauthorized' : 'Forbidden' });
    const { linkId } = req.query;
    if (!isLinkToken(linkId) || !(await revokeLink(minter.credential, linkId)))
      return res.status(404).json({ error: 'Not found' });
    logToAxiom({
      name: 'download-link',
      type: 'info',
      message: 'revoke',
      linkId,
      credentialKind: minter.credential.kind,
      credentialId: minter.credential.id,
    }).catch(() => undefined);
    return res.status(204).end();
  } catch (error) {
    logToAxiom({
      ...safeError(error),
      name: 'download-link',
      type: 'error',
      message: 'revoke-failed',
    }).catch(() => undefined);
    return handleEndpointError(res, error);
  }
}
