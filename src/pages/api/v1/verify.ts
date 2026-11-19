import type { NextApiResponse } from 'next';
import {
  readContentCredentials,
  sniffImageType,
  VerifyBusyError,
} from '~/server/services/content-credentials.service';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import { checkPublicApiRateLimit } from '~/server/utils/public-api-rate-limit';
import { PayloadTooLarge, readRawBody } from '~/server/utils/raw-body';
import { restErrorBody, type RestErrorCode } from '~/server/utils/rest-error-envelope';

export const config = { api: { bodyParser: false } };

// src/proxy.ts silently truncates /api/v1 bodies past 10 MiB (see image-upload/relay.ts),
// so a larger cap could never bind.
export const MAX_VERIFY_BYTES = 10 * 1024 * 1024;

function fail(
  res: NextApiResponse,
  status: number,
  message: string,
  code: RestErrorCode = 'BAD_REQUEST'
) {
  return res.status(status).json(restErrorBody(code, message));
}

// POST /api/v1/verify, body: the raw image file. Nothing is stored or logged.
export default MixedAuthEndpoint(
  async function handler(req, res, user) {
    res.setHeader('Cache-Control', 'no-store');

    // Closed on a redis error, unlike the read endpoints: every request here parses an upload.
    const limits = await Promise.all(
      user
        ? [
            checkPublicApiRateLimit({ req, family: 'verify', userId: user.id, failOpen: false }),
            checkPublicApiRateLimit({ req, family: 'verify-signed-in-ip', failOpen: false }),
          ]
        : [checkPublicApiRateLimit({ req, family: 'verify', failOpen: false })]
    );
    const blocked = limits.find((l) => !l.allowed);
    if (blocked && !blocked.allowed) {
      res.setHeader('Retry-After', String(blocked.retryAfterSeconds));
      return fail(res, 429, 'Rate limit exceeded, please retry shortly.', 'TOO_MANY_REQUESTS');
    }

    // Required: without it a body the proxy truncated looks complete, and a cut-off signed file
    // reads as tampered.
    const declared = Number(req.headers['content-length']);
    if (!Number.isInteger(declared) || declared < 0)
      return fail(res, 411, 'Send the file with a Content-Length header');
    if (declared === 0) return fail(res, 400, 'The file is empty');
    if (declared > MAX_VERIFY_BYTES) return fail(res, 413, 'File too large');

    let body: Buffer;
    try {
      body = await readRawBody(req, MAX_VERIFY_BYTES);
    } catch (e) {
      if (e instanceof PayloadTooLarge) return fail(res, 413, 'File too large');
      throw e;
    }
    if (body.length < declared) return fail(res, 400, 'Upload body was incomplete');

    const mimeType = sniffImageType(body);
    if (!mimeType) return fail(res, 415, 'Send a JPEG, PNG, WebP, AVIF or HEIC image');

    try {
      return res.status(200).json(await readContentCredentials(body, mimeType));
    } catch (e) {
      if (!(e instanceof VerifyBusyError)) throw e;
      res.setHeader('Retry-After', '5');
      return fail(res, 503, 'Busy, please retry shortly.', 'TOO_MANY_REQUESTS');
    }
  },
  ['POST']
);
