import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type ItemKind = 'queue' | 'hidden' | 'yesno';
export type ItemRef = { kind: ItemKind; id: number };
/** An opened token: the item and when the server issued it (null on a token sealed before the issue time was added). */
export type OpenedItem = ItemRef & { issuedAt: number | null };

/** The longest time on an item that is believed; a page left open for longer says nothing about the judgment. */
export const MAX_MS_ON_ITEM = 600_000;

const KIND_BYTE: Record<ItemKind, string> = { queue: 'q', hidden: 'h', yesno: 'y' };
const PLAINTEXT_LENGTH = 40;
const keyOf = (secret: string) => createHash('sha256').update(`knights-feed:${secret}`).digest();

/**
 * Every feed item is addressed by one of these, hidden check or not, so nothing in the page tells them apart.
 * Encrypted, padded to a fixed size and bound to the player, so it can be neither read, forged nor passed on.
 * It also carries the server's issue time (epoch ms), which is what `msOnItem` measures from; the client cannot set or alter it.
 */
export function sealItem(
  secret: string,
  playerId: number,
  ref: ItemRef,
  issuedAt: number = Date.now()
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const plain = `${KIND_BYTE[ref.kind]}:${playerId}:${ref.id}:${Math.trunc(issuedAt)}`.padEnd(
    PLAINTEXT_LENGTH,
    ' '
  );
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function openItem(secret: string, playerId: number, token: string): OpenedItem | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length !== 12 + 16 + PLAINTEXT_LENGTH) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString();
    const [kind, owner, id, issued] = plain.trim().split(':');
    const found = (Object.keys(KIND_BYTE) as ItemKind[]).find((k) => KIND_BYTE[k] === kind);
    if (!found || Number(owner) !== playerId || !Number.isInteger(Number(id))) return null;
    const issuedAt =
      issued !== undefined && Number.isInteger(Number(issued)) ? Number(issued) : null;
    return { kind: found, id: Number(id), issuedAt };
  } catch {
    return null;
  }
}

/** Milliseconds from the token's issue to `now`, clamped to 0..`MAX_MS_ON_ITEM`; null when the token carried no issue time. */
export function msOnItem(issuedAt: number | null, now: Date): number | null {
  if (issuedAt === null) return null;
  return Math.min(MAX_MS_ON_ITEM, Math.max(0, Math.round(now.getTime() - issuedAt)));
}
