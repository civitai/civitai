import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { dbRead } from '~/server/db/client';
import { createImageIngestionRequest } from '~/server/services/orchestrator/orchestrator.service';
import { ImageIngestionUrlBlockedError } from '~/server/utils/image-scan-url';
import type { MediaType } from '~/shared/utils/prisma/enums';

/**
 * Strip every occurrence of each secret from a value, via its JSON serialization.
 *
 * The orchestrator's failure body echoes the submitted workflow, whose callback entry
 * carries a token. The route is moderator-OR-token gated, so the echo leaks nothing a
 * token-holder lacks — but it must not hand the secret to a moderator (or to whoever can
 * reach a 502 response body in logs/support screenshots).
 *
 * 🔴 Takes a LIST, and the caller passes the callback URL actually in use, not just
 * `WEBHOOK_TOKEN`: the callback is `env.IMAGE_SCANNING_CALLBACK` whenever that is set
 * (production takes that branch), and if the override carries its own secret query param
 * then splitting on `WEBHOOK_TOKEN` strips nothing while looking like it worked.
 *
 * 🔴 Redacts the whole response object, not one field: `error` comes from the orchestrator
 * and a validation-error payload that echoes submitted fields would carry the same
 * callback entry.
 */
export function redactSecrets<T>(value: T, secrets: Array<string | undefined>): T {
  if (value == null) return value;
  // Longest first, so a URL containing a token is removed before the token alone.
  const needles = secrets
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .sort((a, b) => b.length - a.length);
  if (!needles.length) return value;
  try {
    let json = JSON.stringify(value);
    if (json === undefined) return value;
    for (const secret of needles) {
      // Replace the raw form AND the form `JSON.stringify` emits. A secret containing a
      // character JSON escapes (`"`, `\`, a control char) never appears raw in the
      // serialized string, so a raw-only split would silently redact nothing.
      const escaped = JSON.stringify(secret).slice(1, -1);
      for (const needle of new Set([secret, escaped])) {
        // split/join, not a regex — a secret may contain regex metacharacters.
        json = json.split(needle).join('<redacted>');
      }
    }
    return JSON.parse(json) as T;
  } catch {
    return '<redacted>' as unknown as T;
  }
}

/**
 * GET /api/media/ingest/:mediaId
 *
 * Re-ingests an image/video through the orchestrator. Intended as a debugging
 * tool for moderators and orchestrator devs.
 *
 * Auth: pass `?token=$WEBHOOK_TOKEN` OR be signed in as a moderator.
 *
 * On orchestrator failure, returns `{ error, status, body }` so the caller can
 * inspect the exact request body that was submitted.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tokenAuthed = !!req.query.token && req.query.token === env.WEBHOOK_TOKEN;
  if (!tokenAuthed) {
    const session = await getServerAuthSession({ req, res });
    if (!session?.user?.isModerator || session.user.bannedAt) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const mediaId = Number(req.query.mediaId);
  if (!Number.isFinite(mediaId)) {
    return res.status(400).json({ error: 'Invalid mediaId' });
  }

  const media = await dbRead.image.findUnique({
    where: { id: mediaId },
    select: { id: true, url: true, type: true },
  });
  if (!media) return res.status(404).json({ error: 'Media not found' });

  const callbackUrl =
    env.IMAGE_SCANNING_CALLBACK ??
    `${env.NEXTAUTH_URL}/api/webhooks/image-scan-result?token=${env.WEBHOOK_TOKEN}`;

  try {
    const { data, body, error, status } = await createImageIngestionRequest({
      imageId: media.id,
      url: media.url,
      type: media.type as MediaType,
      callbackUrl,
    });
    if (!data) {
      return res
        .status(502)
        .json(
          redactSecrets({ error: error ?? 'Ingestion request failed', status, body }, [
            callbackUrl,
            env.WEBHOOK_TOKEN,
          ])
        );
    }
    return res.status(200).json({ workflowId: data.id });
  } catch (e) {
    if (e instanceof ImageIngestionUrlBlockedError) {
      return res.status(400).json({ error: e.message });
    }
    const err = e as Error;
    return res
      .status(500)
      .json(
        redactSecrets({ error: 'Internal Server Error', message: err.message }, [
          callbackUrl,
          env.WEBHOOK_TOKEN,
        ])
      );
  }
}
