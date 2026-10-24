import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { matchesConfiguredSecret } from '~/server/utils/configured-secret';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';
import { dbRead } from '~/server/db/client';
import { createImageIngestionRequest } from '~/server/services/orchestrator/orchestrator.service';
import { ImageIngestionUrlBlockedError } from '~/server/utils/image-scan-url';
// Lifted out of this file into a shared module when `services/ai/jev.ts` became the second
// caller — this file's own comment asked the next one to do exactly that rather than grow a
// third copy. Re-exported so the existing test's import keeps working.
import { redactKnownValues } from '~/server/utils/redact-known-values';
import type { MediaType } from '~/shared/utils/prisma/enums';

export { redactKnownValues as redactSecrets };

/**
 * GET /api/media/ingest/:mediaId
 *
 * Re-ingests an image/video through the orchestrator. Intended as a debugging
 * tool for moderators and orchestrator devs.
 *
 * Auth: pass `?token=$WEBHOOK_TOKEN`, or a moderator's browser session or full-scope personal API key.
 *
 * On orchestrator failure, returns `{ error, status, body }` so the caller can
 * inspect the exact request body that was submitted.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tokenAuthed = matchesConfiguredSecret(req.query.token, env.WEBHOOK_TOKEN);
  if (!tokenAuthed) {
    const session = await getServerAuthSession({ req, res });
    if (!session?.user?.isModerator || session.user.bannedAt) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!requireFullScopeSession(req, res)) return;
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
          redactKnownValues({ error: error ?? 'Ingestion request failed', status, body }, [
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
        redactKnownValues({ error: 'Internal Server Error', message: err.message }, [
          callbackUrl,
          env.WEBHOOK_TOKEN,
        ])
      );
  }
}
