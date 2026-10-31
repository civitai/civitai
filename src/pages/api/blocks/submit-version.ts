import type { NextApiResponse } from 'next';
import { isProd } from '~/env/other';
import {
  submitVersionParseErrorMessage,
  submitVersionSchema,
} from '~/server/schema/blocks/publish-request.schema';
import { isAppBlocksAuthorEnabled, isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { SUBMIT_RATE_LIMIT, takeSubmitSlot } from '~/server/services/blocks/submit-rate-limit';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { isAllowedOriginRequest } from '~/server/utils/origin-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';
import { APPS_RESTRICTED_MESSAGE } from '~/shared/constants/app-submit.constants';

/**
 * Dedicated upload route for the App Blocks W1 publish-request flow, for a SIGNED-IN BROWSER
 * (session cookie): App Assistant's Submit for review button posts here.
 *
 * The bundle is a base64-encoded ZIP (50 MiB max → ~67 MiB encoded), which
 * exceeds the shared tRPC body limit. Rather than raise the limit on the
 * single `/api/trpc/[trpc]` route — which would lift the cap for EVERY tRPC
 * call app-wide — the upload lives here so the 72 MiB body limit is isolated
 * to the one endpoint that needs it. The shared tRPC route stays at 17 MiB.
 *
 * It is the session front door to the SAME flow as the CLI's token route
 * (`src/pages/api/v1/blocks/submit-version.ts`), with the SAME gates, and it hands the bundle
 * to the SAME `submitVersion` service — nothing is published: every submission lands in the
 * moderator review queue as `pending`.
 *   - auth: a signed-in session, or a full-access personal key (`requireFullScopeSession`); an
 *     OAuth-client token never reaches the service here, scoped or not (the CLI route is the
 *     one that takes the `AppBlocksSubmit` scope),
 *   - not banned, and the authoring capability (`isAppBlocksAuthorEnabled`, mod floor) — the
 *     CLI route's step 2, verbatim,
 *   - gated on the appBlocks flag (503 when off, mirroring enforceAppBlocksFlag),
 *   - requires bundle storage to be configured,
 *   - the same per-subject rate limit (`takeSubmitSlot`), keyed on the user,
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

export default AuthedEndpoint(
  async (req, res: NextApiResponse, user) => {
    // CSRF guard. This raw route takes the session cookie (or a full-access
    // personal key) and bypasses the tRPC pipeline, so it never gets
    // createContext's same-origin check; in prod a bearer caller without an
    // allowed Origin is refused too (no exemption, unlike createContext). With the
    // prod session cookie set to sameSite:'none', a cross-site HTML form POST
    // in a logged-in author's browser would otherwise submit a bundle with
    // their cookie. Mirror createContext's posture: in prod, require the
    // request to originate from an allowed host. The !isProd exemption keeps
    // local dev and tests (which send no Origin) working, identical to
    // createContext.
    if (isProd && !isAllowedOriginRequest(req)) {
      res.status(403).json({ message: 'Cross-origin request blocked' });
      return;
    }

    // A session, or a full-access personal key: never an OAuth-client token (App Assistant's own
    // tokens included), which only the CLI route judges, by its `AppBlocksSubmit` scope.
    if (!requireFullScopeSession(req, res)) return;

    // Author gate — identical to the CLI route: a banned account never, else the
    // `app-blocks-author` capability (static fallback mod-only). Before the flag and the body,
    // so a non-author never costs a decode.
    if (user.bannedAt || !(await isAppBlocksAuthorEnabled({ user }))) {
      res.status(403).json({ message: APPS_RESTRICTED_MESSAGE });
      return;
    }

    // H2: evaluate with the authenticated user's context so the
    // `moderators`-segmented flag resolves for them. Mirrors enforceAppBlocksFlag.
    if (!(await isAppBlocksEnabled({ user }))) {
      res.status(503).json({ message: 'Apps are not enabled' });
      return;
    }

    const { env } = await import('~/env/server');
    if (!env.BUNDLE_S3_ENDPOINT || !env.BUNDLE_S3_BUCKET) {
      res.status(412).json({ message: 'Bundle storage not configured in this environment' });
      return;
    }

    // Per user, as the CLI route's is per key; fails closed (`takeSubmitSlot`).
    const slot = await takeSubmitSlot(`user:${user.id}`);
    if (!slot.ok && slot.reason !== 'limited') {
      res.status(503).json({ message: 'Rate limiter unavailable; please retry' });
      return;
    }
    if (!slot.ok) {
      res.setHeader('Retry-After', String(Math.max(slot.retryAfterSeconds, 1)));
      res.status(429).json({
        message: 'Rate limit exceeded',
        retryAfterSeconds: slot.retryAfterSeconds,
        limit: SUBMIT_RATE_LIMIT.max,
        windowSeconds: SUBMIT_RATE_LIMIT.windowSeconds,
      });
      return;
    }

    const parsed = submitVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      // Names the offending field when the failure is confined to the #4059
      // provenance fields; still exactly 'Invalid bundle payload' for a bundle
      // problem. See submitVersionParseErrorMessage.
      res.status(400).json({ message: submitVersionParseErrorMessage(parsed.error) });
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
      const result = await submitVersion({
        bundleBuffer,
        submittedByUserId: user.id,
        submitterIsModerator: !!user.isModerator,
        // #4059 — pass the client's provenance CLAIM through untouched. Absent
        // stays absent; the service must not invent a value.
        sourceCommit: parsed.data.sourceCommit,
        sourceDirty: parsed.data.sourceDirty,
      });
      // The stable subset, as the CLI route answers: never the file or manifest diff against the
      // previous approved version, which is moderator review material.
      res.status(200).json({
        publishRequestId: result.publishRequestId,
        slug: result.slug,
        version: result.version,
        status: 'pending',
        // The store listing's readiness: whether a moderator can approve this yet (icon +
        // cover), the plain-words next step, and every blocking / advisory listing problem.
        // `null` when it could not be read. Additive — older clients ignore it.
        listing: result.listing ?? null,
      });
    } catch (err) {
      // Service throws plain Errors with human-readable messages (bundle too
      // large, missing manifest, invalid blockId / version / name, etc).
      // Surface as 400 so the form can render them inline.
      res.status(400).json({ message: (err as Error).message });
    }
  },
  ['POST']
);
