import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption of a sleeping app's `.env*` files, done entirely by civitai.
 *
 *   - The sandbox service sends the files as one opaque blob in `commit`. civitai generates a
 *     fresh random 32-byte DATA KEY per archive, seals the blob with it ({@link sealSecrets}), and
 *     stores only the sealed bytes. No key ever goes to the sandbox service.
 *   - civitai keeps the data key only WRAPPED by the current master key, which never leaves
 *     civitai: {@link wrapDataKey} / {@link unwrapDataKey}. The master keys are a KEYRING
 *     (`APP_ARCHIVE_SECRETS_MASTER_KEYS`, {@link parseMasterKeys}): the first entry wraps, and every
 *     entry can unwrap, so a key is rotated by putting a new one first and keeping the old one
 *     listed until nothing wrapped under it is left.
 *   - Both layers are AES-256-GCM, and each binds the (user, app, attempt) it belongs to as
 *     additional authenticated data, so neither a sealed blob nor a wrapped key can be moved to
 *     another user's or another app's record: decryption fails instead.
 *
 * Sealed blob format: nonce (12 bytes) || ciphertext || GCM tag (16 bytes), key = the data key,
 * AAD = UTF-8 of {@link secretsAad}(userId, appKey, attemptId).
 */

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** `v2.<kid>.<base64>`: the key id names the master key that wrapped it. */
const WRAPPED_V2 = 'v2';
/** `v1.<base64>`: no key id (the first format); unwrapped by trying every key on the ring. */
const WRAPPED_V1 = 'v1';
const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** The AAD a secrets blob is sealed with. */
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

export type MasterKeyring = {
  /** The key new data keys are wrapped with. */
  current: { kid: string; key: Buffer };
  /** Every key that may unwrap, the current one included. */
  keys: ReadonlyMap<string, Buffer>;
};

/**
 * The keyring from its env value: comma-separated `<kid>:<base64 of 32 bytes>` entries, the
 * CURRENT key first, then the old ones still needed to unwrap. `null` when it is unset, or when
 * any entry is malformed or a key id repeats: a misconfiguration disables the feature instead of
 * wrapping under the wrong key.
 */
export function parseMasterKeys(value: string | null | undefined): MasterKeyring | null {
  if (!value || value.trim() === '') return null;
  const keys = new Map<string, Buffer>();
  let current: MasterKeyring['current'] | null = null;
  for (const entry of value.split(',')) {
    const at = entry.indexOf(':');
    if (at < 0) return null;
    const kid = entry.slice(0, at).trim();
    const key = parseMasterKey(entry.slice(at + 1));
    if (!KID_RE.test(kid) || !key || keys.has(kid)) return null;
    keys.set(kid, key);
    current ??= { kid, key };
  }
  return current ? { current, keys } : null;
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

/** Wraps a data key under the CURRENT master key, as the text stored in the record. */
export function wrapDataKey(ring: MasterKeyring, b: Binding, dataKey: Buffer): string {
  const sealed = seal(ring.current.key, wrapAad(b.userId, b.appKey, b.attemptId), dataKey);
  return `${WRAPPED_V2}.${ring.current.kid}.${sealed.toString('base64')}`;
}

/**
 * Unwraps a stored data key with the master key its id names (`v2`), or with whichever key on the
 * ring opens it (`v1`, no id). Throws on an unknown key id, a wrong key, a wrong binding or
 * tampering.
 */
export function unwrapDataKey(ring: MasterKeyring, b: Binding, wrapped: string): Buffer {
  const aad = wrapAad(b.userId, b.appKey, b.attemptId);
  const parts = wrapped.split('.');
  let key: Buffer | undefined;
  if (parts[0] === WRAPPED_V2 && parts.length === 3 && parts[1] && parts[2]) {
    const master = ring.keys.get(parts[1]);
    if (!master) throw new Error('secrets: wrapped under an unknown master key id');
    key = open(master, aad, Buffer.from(parts[2], 'base64'));
  } else if (parts[0] === WRAPPED_V1 && parts.length === 2 && parts[1]) {
    const sealed = Buffer.from(parts[1], 'base64');
    for (const master of ring.keys.values()) {
      try {
        key = open(master, aad, sealed);
        break;
      } catch {
        // Not this key; try the next.
      }
    }
    if (!key) throw new Error('secrets: no master key on the ring opens this wrapped key');
  } else {
    throw new Error('secrets: unknown wrapped-key format');
  }
  if (key.length !== KEY_BYTES) throw new Error('secrets: unwrapped key is not 32 bytes');
  return key;
}

/** A `v1` wrapped key (no key id), as the first format wrote it. Kept for the compatibility test. */
export function wrapDataKeyV1(masterKey: Buffer, b: Binding, dataKey: Buffer): string {
  const sealed = seal(masterKey, wrapAad(b.userId, b.appKey, b.attemptId), dataKey);
  return `${WRAPPED_V1}.${sealed.toString('base64')}`;
}
