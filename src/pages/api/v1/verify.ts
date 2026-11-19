import {
  readContentCredentials,
  sniffImageType,
} from '~/server/services/content-credentials.service';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import { checkPublicApiRateLimit } from '~/server/utils/public-api-rate-limit';
import { PayloadTooLarge, readRawBody } from '~/server/utils/raw-body';

export const config = { api: { bodyParser: false } };

// src/proxy.ts silently truncates /api/v1 bodies past 10 MiB (see image-upload/relay.ts),
// so a larger cap could never bind.
export const MAX_VERIFY_BYTES = 10 * 1024 * 1024;

// POST /api/v1/verify, body: the raw image file. Nothing is stored or logged.
export default MixedAuthEndpoint(
  async function handler(req, res, user) {
    res.setHeader('Cache-Control', 'no-store');

    // Per IP for everyone, and per user too when signed in. Closed on a redis error, unlike the
    // read endpoints: each request here is an in-process parse.
    const limits = await Promise.all([
      checkPublicApiRateLimit({ req, family: 'verify', failOpen: false }),
      user && checkPublicApiRateLimit({ req, family: 'verify', userId: user.id, failOpen: false }),
    ]);
    const blocked = limits.find((l) => l && !l.allowed);
    if (blocked && !blocked.allowed) {
      res.setHeader('Retry-After', String(blocked.retryAfterSeconds));
      return res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    }

    // Required: without it a body the proxy truncated looks complete, and a cut-off signed file
    // reads as tampered.
    const declared = Number(req.headers['content-length']);
    if (!Number.isInteger(declared) || declared <= 0)
      return res.status(411).json({ error: 'Send the file with a Content-Length header' });
    if (declared > MAX_VERIFY_BYTES) return res.status(413).json({ error: 'File too large' });

    let body: Buffer;
    try {
      body = await readRawBody(req, MAX_VERIFY_BYTES);
    } catch (e) {
      if (e instanceof PayloadTooLarge) return res.status(413).json({ error: 'File too large' });
      throw e;
    }
    if (body.length < declared)
      return res.status(400).json({ error: 'Upload body was incomplete' });

    const mimeType = sniffImageType(body);
    if (!mimeType)
      return res.status(415).json({ error: 'Send a JPEG, PNG, WebP, AVIF or HEIC image' });

    return res.status(200).json(await readContentCredentials(body, mimeType));
  },
  ['POST']
);
