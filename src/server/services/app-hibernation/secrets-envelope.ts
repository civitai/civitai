import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption of a sleeping app's `.env*` files.
 *
 *   - Each hibernation attempt gets a fresh random 32-byte DATA KEY. `begin` hands it to the
 *     sandbox service, which encrypts the `.env*` blob with it ({@link sealSecrets}'s format) and
 *     uploads only ciphertext.
 *   - civitai keeps the data key only WRAPPED by the master key (`APP_ARCHIVE_SECRETS_MASTER_KEY`),
 *     which never leaves civitai: {@link wrapDataKey} / {@link unwrapDataKey}.
 *   - Both layers are AES-256-GCM, and each binds the (user, app, attempt) it belongs to as
 *     additional authenticated data, so neither a blob nor a wrapped key can be moved to another
 *     user's or another app's record: decryption fails instead.
 *
 * Secrets blob wire format (what the sandbox service must produce):
 *   nonce (12 bytes) || ciphertext || GCM tag (16 bytes)
 *   key = the data key, AAD = UTF-8 of {@link secretsAad}(userId, appKey, attemptId).
 */

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const WRAPPED_PREFIX = 'v1';

/** The AAD a secrets blob is sealed with. Part of the wire contract with the sandbox service. */
export function secretsAad(userId: number, appKey: string, attemptId: string): string {
  return `civitai-app-secrets:v1:${userId}:${appKey}:${attemptId}`;
}

function wrapAad(userId: number, appKey: string, attemptId: string): string {
  return `civitai-app-secrets-key:v1:${userId}:${appKey}:${attemptId}`;
}

/**
 * The master key from its env value (base64 of exactly 32 bytes), or `null` when it is unset or
 * malformed, so a misconfiguration disables the feature instead of encrypting under a weak key.
 */
export function parseMasterKey(value: string | null | undefined): Buffer | null {
  if (!value || value.trim() === '') return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const key = Buffer.from(trimmed, 'base64');
  return key.length === KEY_BYTES ? key : null;
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

function seal(key: Buffer, aad: string, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, new Uint8Array(key), new Uint8Array(nonce));
  cipher.setAAD(new Uint8Array(Buffer.from(aad, 'utf8')));
  const body = Buffer.concat([
    new Uint8Array(cipher.update(new Uint8Array(plaintext))),
    new Uint8Array(cipher.final()),
  ]);
  return Buffer.concat([
    new Uint8Array(nonce),
    new Uint8Array(body),
    new Uint8Array(cipher.getAuthTag()),
  ]);
}

/** Throws on a wrong key, wrong AAD or any tampering (GCM authentication). */
function open(key: Buffer, aad: string, sealed: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('secrets: key must be 32 bytes');
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error('secrets: sealed value too short');
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, new Uint8Array(key), new Uint8Array(nonce));
  decipher.setAAD(new Uint8Array(Buffer.from(aad, 'utf8')));
  decipher.setAuthTag(new Uint8Array(tag));
  return Buffer.concat([
    new Uint8Array(decipher.update(new Uint8Array(body))),
    new Uint8Array(decipher.final()),
  ]);
}

type Binding = { userId: number; appKey: string; attemptId: string };

/** Encrypts a `.env*` blob with a data key, in the wire format above. */
export function sealSecrets(dataKey: Buffer, b: Binding, plaintext: Buffer): Buffer {
  return seal(dataKey, secretsAad(b.userId, b.appKey, b.attemptId), plaintext);
}

/** Decrypts a secrets blob. Throws when the key, the binding or the bytes are wrong. */
export function openSecrets(dataKey: Buffer, b: Binding, sealed: Buffer): Buffer {
  return open(dataKey, secretsAad(b.userId, b.appKey, b.attemptId), sealed);
}

/** Wraps a data key under the master key, as the text stored in the record. */
export function wrapDataKey(masterKey: Buffer, b: Binding, dataKey: Buffer): string {
  const sealed = seal(masterKey, wrapAad(b.userId, b.appKey, b.attemptId), dataKey);
  return `${WRAPPED_PREFIX}.${sealed.toString('base64')}`;
}

/** Unwraps a stored data key. Throws on a wrong master key, a wrong binding or tampering. */
export function unwrapDataKey(masterKey: Buffer, b: Binding, wrapped: string): Buffer {
  const [prefix, body, ...rest] = wrapped.split('.');
  if (prefix !== WRAPPED_PREFIX || !body || rest.length > 0)
    throw new Error('secrets: unknown wrapped-key format');
  const key = open(
    masterKey,
    wrapAad(b.userId, b.appKey, b.attemptId),
    Buffer.from(body, 'base64')
  );
  if (key.length !== KEY_BYTES) throw new Error('secrets: unwrapped key is not 32 bytes');
  return key;
}
