import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { handleZkp2pCallback } from '~/server/wallet';
import { createAuthOptions } from '~/pages/api/auth/[...nextauth]';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const authOptions = createAuthOptions(req);
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { key, txHash } = req.body;

    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'Invalid or missing key' });
    }

    if (!key.startsWith('zkp2p-')) {
      return res.status(400).json({ error: 'Invalid ZKP2P transaction key' });
    }

    await handleZkp2pCallback(session.user.id, key, txHash);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('ZKP2P callback error:', error);
    return res.status(500).json({
      error: 'Failed to process ZKP2P callback',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
