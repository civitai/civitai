import { createHash, createHmac } from 'node:crypto';
import { base32Decode, base32Encode } from '~/server/utils/base32';
import { PREVIEW_LABEL_SHAPE } from '~/shared/constants/app-frame-hosts.constants';

/**
 * App Assistant direct preview: the SESSION HOST civitai mints for one preview session, and the
 * only credential the preview gateway checks on each request (no cookie, no entry token). Pure:
 * no env, no Redis. The gateway verifies the same bytes; the shared test vector
 * (`__tests__/fixtures/preview-label-v1.json`) pins both implementations to one format.
 *
 *   host  = label + "." + <APP_ASSISTANT_PREVIEW_DOMAIN>
 *   label = "s" + unpadded lowercase RFC 4648 base32 of 38 bytes (61 chars) = 62 chars
 *   [0]       (version << 4) | kid      version 1; kid selects the key (0..15)
 *   [1..16]   preview id                the Sandbox's preview id, 32 lowercase hex
 *   [17..21]  user id                   40-bit big-endian
 *   [22..25]  exp                       uint32 big-endian Unix seconds
 *   [26..37]  MAC                       HMAC-SHA256(key, "sandbox-preview:v1:" || [0..25]), first 12 bytes
 *
 * 61 base32 characters carry 305 bits for 304 bits of data, so the last character has one spare
 * bit: a label is accepted only in its canonical encoding (decode, re-encode, compare), so one
 * session has exactly one host.
 */

export const PREVIEW_LABEL_VERSION = 1;
const MAC_DOMAIN = 'sandbox-preview:v1:';
const RAW_BYTES = 38;
const SIGNED_BYTES = 26;
const MAC_BYTES = 12;
/** The full DNS label: "s" + 61 base32 characters, inside the 63-character label limit. */
export const PREVIEW_LABEL_LENGTH = 62;
const LABEL_SHAPE = PREVIEW_LABEL_SHAPE;
export const PREVIEW_ID_REGEX = /^[0-9a-f]{32}$/;
const MAX_USER_ID = 2 ** 40 - 1;

export type PreviewKey = { kid: number; key: Buffer };

export type PreviewLabelFields = {
  kid: number;
  previewId: string;
  userId: number;
  /** Unix seconds. */
  exp: number;
};

function signedBytes(f: PreviewLabelFields): Buffer {
  const b = Buffer.alloc(SIGNED_BYTES);
  b[0] = ((PREVIEW_LABEL_VERSION & 0xf) << 4) | (f.kid & 0xf);
  Buffer.from(f.previewId, 'hex').copy(b, 1);
  b.writeUIntBE(f.userId, 17, 5);
  b.writeUInt32BE(f.exp, 22);
  return b;
}

function macOf(key: Buffer, signed: Buffer): Buffer {
  return createHmac('sha256', new Uint8Array(key))
    .update(MAC_DOMAIN)
    .update(new Uint8Array(signed))
    .digest()
    .subarray(0, MAC_BYTES);
}

/** Mint the session label for `fields` under `key` (whose kid must equal `fields.kid`). Throws on out-of-range fields. */
export function mintPreviewLabel(fields: PreviewLabelFields, key: Buffer): string {
  const { kid, previewId, userId, exp } = fields;
  if (!Number.isInteger(kid) || kid < 0 || kid > 15) throw new Error('kid must be 0..15');
  if (!PREVIEW_ID_REGEX.test(previewId)) throw new Error('previewId must be 32 lowercase hex');
  if (!Number.isSafeInteger(userId) || userId < 0 || userId > MAX_USER_ID)
    throw new Error('userId must fit 40 bits');
  if (!Number.isInteger(exp) || exp < 0 || exp > 0xffffffff)
    throw new Error('exp must fit 32 bits');
  const signed = signedBytes(fields);
  return 's' + base32Encode(Buffer.concat([signed, macOf(key, signed)]));
}

export type PreviewLabelDecode =
  | ({ ok: true } & PreviewLabelFields)
  | { ok: false; reason: 'malformed' | 'non_canonical' | 'bad_version' };

/**
 * The fields of a well-formed label, WITHOUT checking its MAC or expiry: civitai's own records are
 * what it reads this from, and a record minted under a key since rotated must still read. Refuses
 * anything not in the canonical encoding (upper case, a set spare bit) and any other version.
 */
export function decodePreviewLabel(label: string): PreviewLabelDecode {
  if (typeof label !== 'string' || label.length !== PREVIEW_LABEL_LENGTH)
    return { ok: false, reason: 'malformed' };
  if (!LABEL_SHAPE.test(label.toLowerCase())) return { ok: false, reason: 'malformed' };
  const raw = base32Decode(label.slice(1).toLowerCase());
  if (!raw || raw.length !== RAW_BYTES) return { ok: false, reason: 'malformed' };
  if ('s' + base32Encode(raw) !== label) return { ok: false, reason: 'non_canonical' };
  const head = raw[0];
  if (head >> 4 !== PREVIEW_LABEL_VERSION) return { ok: false, reason: 'bad_version' };
  return {
    ok: true,
    kid: head & 0xf,
    previewId: raw.subarray(1, 17).toString('hex'),
    userId: raw.readUIntBE(17, 5),
    exp: raw.readUInt32BE(22),
  };
}

export type PreviewSigningKeyParse =
  | { ok: true; key: PreviewKey }
  | { ok: false; reason: 'unset' | 'invalid'; error?: string };

/** One `{kid, key}`: kid 0..15, key base64 of at least 32 bytes. Throws with the field at fault. */
function parseOneKey(x: unknown, name: string): PreviewKey {
  const o = (x && typeof x === 'object' ? x : {}) as { kid?: unknown; key?: unknown };
  if (typeof o.kid !== 'number' || !Number.isInteger(o.kid) || o.kid < 0 || o.kid > 15)
    throw new Error(`${name}.kid must be an integer 0..15`);
  if (typeof o.key !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.key))
    throw new Error(`${name}.key must be base64`);
  const key = Buffer.from(o.key, 'base64');
  if (key.length < 32) throw new Error(`${name}.key must be at least 32 bytes`);
  return { kid: o.kid, key };
}

/**
 * The signing key from its env form. Two shapes are read:
 *   - the preview gateway's key set, `{"current": {kid, key}, "previous"?: {kid, key}}`, so the
 *     operator sets one value on both sides; civitai mints with `current` only, and `previous`
 *     is checked as the gateway checks it (well formed, a different kid) so a value the gateway
 *     would refuse is refused here too;
 *   - a bare `{"kid": <0..15>, "key": "<base64, at least 32 bytes>"}`.
 * `unset` for no value; `invalid` (with the reason) for anything else, and direct preview then
 * stays off.
 */
export function parsePreviewSigningKeyResult(raw: string | undefined): PreviewSigningKeyParse {
  if (!raw || !raw.trim()) return { ok: false, reason: 'unset' };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid', error: 'not JSON' };
  }
  try {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    if (!('current' in o)) return { ok: true, key: parseOneKey(o, 'key') };
    const current = parseOneKey(o.current, 'current');
    if (o.previous !== undefined && o.previous !== null) {
      const previous = parseOneKey(o.previous, 'previous');
      if (previous.kid === current.kid)
        throw new Error('previous.kid must differ from current.kid');
    }
    return { ok: true, key: current };
  } catch (e) {
    return { ok: false, reason: 'invalid', error: (e as Error).message };
  }
}

/** `parsePreviewSigningKeyResult`'s key, or null when there is none to mint with. */
export function parsePreviewSigningKey(raw: string | undefined): PreviewKey | null {
  const parsed = parsePreviewSigningKeyResult(raw);
  return parsed.ok ? parsed.key : null;
}

/**
 * A session host as logs may carry it: the first 12 hex of its SHA-256. The host is the session's
 * only credential (whoever holds it is served the preview), so it is never logged in full.
 */
export function previewHostHash(host: string): string {
  return createHash('sha256').update(host).digest('hex').slice(0, 12);
}
