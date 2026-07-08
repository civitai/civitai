import type { NextApiRequest, NextApiResponse } from 'next';
import { DeliveryWorkerError, getDownloadUrl } from '~/utils/delivery-worker';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { dbWrite, dbRead } from '~/server/db/client';
import requestIp from 'request-ip';
import { isClientAbortError } from '~/server/utils/errorHandling';
import { logToAxiom, safeError } from '~/server/logging/client';

export default async function downloadTrainingData(req: NextApiRequest, res: NextApiResponse) {
  // Get ip so that we can block exploits we catch
  const ip = requestIp.getClientIp(req);
  const blacklist = (
    ((await dbRead.keyValue.findUnique({ where: { key: 'ip-blacklist' } }))?.value as string) ?? ''
  ).split(',');
  if (ip && blacklist.includes(ip)) return res.status(403).json({ error: 'Forbidden' });

  const keyParts = req.query.key as string[];
  const key = keyParts.join('/');
  if (!key) return res.status(400).json({ error: 'Missing key' });

  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId) {
    if (req.headers['content-type'] === 'application/json')
      return res.status(401).json({ error: 'Unauthorized' });
    else return res.redirect(`/login?returnUrl=/api/download/${key}`);
  }

  // This is a catch-all `/api/download/[...key]` route. Clients that hit a
  // non-existent sub-path (e.g. `/api/download/images/:id`, which is NOT a real
  // download endpoint) fall through here: the segments are joined into a key
  // like `images/127209598` that the delivery worker cannot resolve. That was
  // the dominant dp-prod raw-500 source — the throw below was unguarded. A key
  // the delivery worker cannot resolve is a CLIENT error (404 / 400), not a 500.
  let url: string | undefined;
  try {
    ({ url } = await getDownloadUrl(key));
  } catch (err: unknown) {
    if (isClientAbortError(err)) {
      if (!res.headersSent) res.status(499).end();
      return;
    }

    if (err instanceof DeliveryWorkerError) {
      // 404/410 → the key doesn't resolve to a stored file (not found).
      // 400     → the delivery worker rejected the key as malformed.
      // Anything else the worker returned (403/429/5xx) is NOT a clean
      // "this key is bad" signal — treat it as a transient backend problem and
      // KEEP it 5xx so a real storage/worker outage is never masked as a 404.
      if (err.statusCode === 404 || err.statusCode === 410)
        return res.status(404).json({ error: 'Not found' });
      if (err.statusCode === 400)
        return res.status(400).json({ error: 'Invalid download key' });

      // Server-fault: a real delivery-worker/storage failure. Error-log to Axiom
      // (mirrors file.service.ts `resolve-download-url-failed`) — safeError sets
      // `name: 'Error'`, so spread it BEFORE our literal `name`. Client-fault
      // 404/410/400 above are intentionally NOT logged (expected, would be noise).
      logToAxiom({
        type: 'error',
        ...safeError(err),
        name: 'resolve-download-url-failed',
        key,
        status: 503,
        workerStatus: err.statusCode,
      }).catch(() => undefined);
      res.setHeader('Retry-After', '2');
      return res.status(503).json({ error: 'Download temporarily unavailable' });
    }

    // Not a DeliveryWorkerError → a fetch transport reject / JSON-parse / other
    // unexpected failure. Cause is unknown, so keep it a hard 500 (do not claim
    // not-found and do not claim retryable). Server-fault → Axiom.
    logToAxiom({
      type: 'error',
      ...safeError(err),
      name: 'resolve-download-url-failed',
      key,
      status: 500,
    }).catch(() => undefined);
    return res.status(500).json({ error: 'Error resolving download' });
  }

  if (!url) {
    // Delivery worker returned OK but no URL — a backend contract violation, not
    // a client error. Surface as 5xx rather than redirecting to `undefined`
    // (which would itself throw a raw 500). Server-fault → Axiom.
    logToAxiom({
      type: 'error',
      name: 'resolve-download-url-failed',
      message: 'delivery worker returned no url',
      key,
      status: 502,
    }).catch(() => undefined);
    return res.status(502).json({ error: 'Download temporarily unavailable' });
  }

  res.redirect(url);
}
