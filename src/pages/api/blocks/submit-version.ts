import type { NextApiResponse } from 'next';
import { isProd } from '~/env/other';
import { submitVersionSchema } from '~/server/schema/blocks/publish-request.schema';
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { isAllowedOriginRequest } from '~/server/utils/origin-helpers';

/**
 * Dedicated upload route for the App Blocks W1 publish-request flow.
 *
 * The bundle is a base64-encoded ZIP (50 MiB max → ~67 MiB encoded), which
 * exceeds the shared tRPC body limit. Rather than raise the limit on the
 * single `/api/trpc/[trpc]` route — which would lift the cap for EVERY tRPC
 * call app-wide — the upload lives here so the 72 MiB body limit is isolated
 * to the one endpoint that needs it. The shared tRPC route stays at 17 MiB.
 *
 * Auth/behaviour parity with the former `blocks.submitVersion` tRPC mutation:
 *   - moderator-only (ModEndpoint enforces session + isModerator + not banned),
 *   - gated on the appBlocks flag (503 when off, mirroring enforceAppBlocksFlag),
 *   - requires bundle storage to be configured,
 *   - decodes + hands the buffer to the same `submitVersion` service.
 */
export const config = {
  api: {
    bodyParser: {
      // 50 MiB ZIP base64-encodes to ~67 MiB JSON, plus envelope overhead.
      // The schema-level cap (MAX_BUNDLE_SIZE_BYTES = 50 MiB) is enforced
      // below and re-checked in the service against the decoded buffer.
      sizeLimit: '72mb',
    },
  },
};

export default ModEndpoint(
  async (req, res: NextApiResponse, user) => {
    // CSRF guard. This raw route is wrapped in ModEndpoint (cookie-only auth)
    // and bypasses the tRPC pipeline, so it never gets createContext's
    // same-origin check. With the prod session cookie set to sameSite:'none',
    // a cross-site HTML form POST in a logged-in mod's browser would otherwise
    // submit a bundle with their cookie. Mirror createContext's posture: in
    // prod, require the request to originate from an allowed host (no bearer
    // exemption needed — ModEndpoint is cookie-only). The !isProd exemption
    // keeps local dev and tests (which send no Origin) working, identical to
    // createContext.
    if (isProd && !isAllowedOriginRequest(req)) {
      res.status(403).json({ message: 'Cross-origin request blocked' });
      return;
    }

    // H2: evaluate with the authenticated mod's context so the
    // `moderators`-segmented flag resolves ON for them (ModEndpoint has already
    // proven `user.isModerator` above). Mirrors enforceAppBlocksFlag.
    if (!(await isAppBlocksEnabled({ user }))) {
      res.status(503).json({ message: 'App Blocks is not enabled' });
      return;
    }

    const { env } = await import('~/env/server');
    if (!env.BUNDLE_S3_ENDPOINT || !env.BUNDLE_S3_BUCKET) {
      res.status(412).json({ message: 'Bundle storage not configured in this environment' });
      return;
    }

    const parsed = submitVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid bundle payload' });
      return;
    }

    // Decode + validate the bundle bytes. The schema's pre-decode cap is a
    // cheap sanity check; the service re-checks against the real post-decode
    // buffer size.
    let bundleBuffer: Buffer;
    try {
      bundleBuffer = Buffer.from(parsed.data.bundleBase64, 'base64');
    } catch (err) {
      res
        .status(400)
        .json({ message: `bundleBase64 is not valid base64: ${(err as Error).message}` });
      return;
    }

    try {
      const { submitVersion } = await import('~/server/services/blocks/publish-request.service');
      const result = await submitVersion({ bundleBuffer, submittedByUserId: user.id });
      res.status(200).json(result);
    } catch (err) {
      // Service throws plain Errors with human-readable messages (bundle too
      // large, missing manifest, invalid blockId / version / name, etc).
      // Surface as 400 so the form can render them inline.
      res.status(400).json({ message: (err as Error).message });
    }
  },
  ['POST']
);
