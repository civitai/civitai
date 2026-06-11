import type { NextApiRequest, NextApiResponse } from 'next';
import { buildOAuthServerMetadata } from '~/server/oauth/discovery-metadata';

/**
 * RFC 8414 — OAuth 2.0 Authorization Server Metadata.
 *
 * MCP clients and other modern OAuth clients probe this path (rather than the
 * OIDC `/.well-known/openid-configuration`) to discover the registration,
 * authorization, and token endpoints. We serve the same core metadata from a
 * single builder so the two documents can't drift.
 */
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.status(200).json(buildOAuthServerMetadata());
}
