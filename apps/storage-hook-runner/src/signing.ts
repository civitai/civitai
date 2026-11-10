import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SIG_SKEW_SECONDS } from './limits.ts';

/**
 * HMAC-SHA256 over the exact raw body bytes, hex, in a header. The replay timestamp `ts`
 * (integer unix SECONDS) travels INSIDE the signed JSON body, so it cannot be changed without
 * breaking the signature. Same scheme as civitai's build-pipeline trigger and callbacks
 * (`triggerBuild` in src/server/services/blocks/apps-pipeline.service.ts, verified in
 * src/pages/api/internal/blocks/build-callback.ts), with two differences:
 *
 *   - `ts` is REQUIRED here, not enforce-if-present: there is no older signer to tolerate.
 *   - the skew window is SIG_SKEW_SECONDS (60), not 300: both ends are our own services.
 *
 * Responses are signed the same way and carry `req` = sha256(raw request body), so a response
 * can be neither forged by a spoofed responder nor replayed onto a different request.
 */

export function sign(secret: string, body: string | Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const HEX_SIG_RE = /^[0-9a-f]{64}$/;

/** Constant-time check of a hex signature header against the raw body. */
export function verifySignature(
  secret: string,
  rawBody: Buffer,
  header: string | string[] | undefined
): boolean {
  if (typeof header !== 'string' || !HEX_SIG_RE.test(header)) return false;
  const expected = Buffer.from(sign(secret, rawBody), 'hex');
  const provided = Buffer.from(header, 'hex');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** The signed `ts` must be an integer within ±SIG_SKEW_SECONDS of now. */
export function checkTimestamp(
  ts: unknown,
  nowSec: number = Math.floor(Date.now() / 1000)
): { ok: true } | { ok: false; reason: string } {
  if (typeof ts !== 'number' || !Number.isInteger(ts)) {
    return { ok: false, reason: 'ts must be integer unix seconds' };
  }
  const skew = Math.abs(nowSec - ts);
  if (skew > SIG_SKEW_SECONDS) {
    return { ok: false, reason: `ts skew ${skew}s exceeds ${SIG_SKEW_SECONDS}s` };
  }
  return { ok: true };
}
