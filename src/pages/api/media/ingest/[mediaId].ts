import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { dbRead } from '~/server/db/client';
import { createImageIngestionRequest } from '~/server/services/orchestrator/orchestrator.service';
import { ImageIngestionUrlBlockedError } from '~/server/utils/image-scan-url';
import type { MediaType } from '~/shared/utils/prisma/enums';

/**
 * The orchestrator's failure body echoes the submitted workflow, whose callback entry
 * carries `?token=$WEBHOOK_TOKEN`. The route is moderator-OR-token gated, so the echo
 * leaks nothing a token-holder lacks — but it must not hand the token to a moderator
 * (or to whoever can reach a 502 response body in logs/support screenshots). Strip every
 * occurrence of the token from the serialized value.
 */
export function redactWebhookToken<T>(value: T, token?: string): T {
  if (value == null || !token) return value;
  try {
    // split/join, not a regex — the token may contain regex metacharacters.
    return JSON.parse(JSON.stringify(value).split(token).join('<redacted>')) as T;
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
        .json({
          error: error ?? 'Ingestion request failed',
          status,
          body: redactWebhookToken(body, env.WEBHOOK_TOKEN),
        });
    }
    return res.status(200).json({ workflowId: data.id });
  } catch (e) {
    if (e instanceof ImageIngestionUrlBlockedError) {
      return res.status(400).json({ error: e.message });
    }
    const err = e as Error;
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
}
