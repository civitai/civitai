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

    const rateLimit = await checkPublicApiRateLimit({ req, family: 'verify', userId: user?.id });
    if (!rateLimit.allowed) {
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      return res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    }

    const declared = Number(req.headers['content-length']);
    if (declared > MAX_VERIFY_BYTES) return res.status(413).json({ error: 'File too large' });

    let body: Buffer;
    try {
      body = await readRawBody(req, MAX_VERIFY_BYTES);
    } catch (e) {
      if (e instanceof PayloadTooLarge) return res.status(413).json({ error: 'File too large' });
      throw e;
    }
    if (body.length === 0 || (Number.isInteger(declared) && body.length < declared))
      return res.status(400).json({ error: 'Upload body was empty or incomplete' });

    const mimeType = sniffImageType(body);
    if (!mimeType)
      return res.status(415).json({ error: 'Send a JPEG, PNG, WebP, AVIF or HEIC image' });

    return res.status(200).json(await readContentCredentials(body, mimeType));
  },
  ['POST']
);
