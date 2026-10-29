import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type ItemKind = 'queue' | 'hidden';
export type ItemRef = { kind: ItemKind; id: number };

const KIND_BYTE: Record<ItemKind, string> = { queue: 'q', hidden: 'h' };
const PLAINTEXT_LENGTH = 40;
const keyOf = (secret: string) => createHash('sha256').update(`knights-feed:${secret}`).digest();

/**
 * Every feed item is addressed by one of these, hidden check or not, so nothing in the page tells them apart.
 * Encrypted, padded to a fixed size and bound to the player, so it can be neither read, forged nor passed on.
 */
export function sealItem(secret: string, playerId: number, ref: ItemRef): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const plain = `${KIND_BYTE[ref.kind]}:${playerId}:${ref.id}`.padEnd(PLAINTEXT_LENGTH, ' ');
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function openItem(secret: string, playerId: number, token: string): ItemRef | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length !== 12 + 16 + PLAINTEXT_LENGTH) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString();
    const [kind, owner, id] = plain.trim().split(':');
    const found = (Object.keys(KIND_BYTE) as ItemKind[]).find((k) => KIND_BYTE[k] === kind);
    if (!found || Number(owner) !== playerId || !Number.isInteger(Number(id))) return null;
    return { kind: found, id: Number(id) };
  } catch {
    return null;
  }
}
