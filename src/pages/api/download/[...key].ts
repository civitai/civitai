import type { NextApiRequest, NextApiResponse } from 'next';
import { DeliveryWorkerError, getDownloadUrl } from '~/utils/delivery-worker';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getDownloadBlocklistValue } from '~/server/services/download-blocklist.service';
import { getTrustedClientIp, parseIpBlocklist } from '~/server/utils/client-ip';
import { isClientAbortError } from '~/server/utils/errorHandling';
import { logToAxiom, safeError } from '~/server/logging/client';

export default async function downloadTrainingData(req: NextApiRequest, res: NextApiResponse) {
  // Get ip so that we can block exploits we catch. Derived via getTrustedClientIp
  // (edge-attested or transport peer only) — an enforcement control must not key
  // on an address the caller supplies. Do not swap this for an inline resolver.
  //
  // Operator note before you add an entry to `ip-blacklist`: a request that did
  // not transit the Cloudflare edge is attributed to the transport peer, so
  // where that peer is a shared hop, listing its address blocks all such traffic
  // to every download route at once rather than one abuser. See
  // `parseIpBlocklist`.
  const ip = getTrustedClientIp(req);
  const blacklist = parseIpBlocklist(await getDownloadBlocklistValue('ip-blacklist'));
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

  // Upload keys are `<type>/<userId>/<name>` (buildUploadKey): a caller may fetch their own uploads
  // here; anything else goes through the download route for its record. Moderators may fetch any key.
  //
  // The prefix match reads segment 1, but the whole joined key is handed to the delivery worker,
  // whose normalization we don't control. Require each segment to be a plain name first — non-empty,
  // not `.`/`..`, and no separator surviving a single decode — so `model/<me>/../../model/<other>/x`
  // or an encoded separator can't resolve past the prefix the match approved.
  const safeSegments = keyParts.every((seg) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return false;
    }
    return seg !== '' && decoded !== '.' && decoded !== '..' && !/[/\\%]/.test(decoded);
  });
  const allowed = safeSegments && (!!session.user?.isModerator || keyParts[1] === String(userId));
  logToAxiom({ type: 'info', name: 'download-key-route', userId, key, allowed }).catch(
    () => undefined
  );
  if (!allowed) return res.status(404).json({ error: 'Not found' });

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
      if (err.statusCode === 400) return res.status(400).json({ error: 'Invalid download key' });

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
