import { dbRead } from '../db';
import { isInt4Id } from '../users.service';

// Registration emails, for a moderator holding `assistant.emails`. A mass-registered chain shows in the
// address itself: one Gmail inbox spelled with different dots, or the same throwaway domains in turn.
// Without the grant the column is never selected.

const GMAIL = new Set(['gmail.com', 'googlemail.com']);

/**
 * The inbox an address delivers to, so spellings of one inbox compare equal. Gmail ignores dots and
 * anything after `+` in the local part, and googlemail.com is the same service. Other providers are
 * only lower-cased: their rules differ, and a wrong merge would read as a link that is not there.
 */
export function normalizeEmail(email: string): string | null {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!GMAIL.has(domain)) return address;
  const inbox = local.split('+')[0].replaceAll('.', '');
  return inbox ? `${inbox}@gmail.com` : null;
}

export async function getRegistrationEmails(
  userIds: number[]
): Promise<Map<number, string | null>> {
  const ids = [...new Set(userIds)].filter(isInt4Id);
  if (!ids.length) return new Map();
  const rows = await dbRead
    .selectFrom('User')
    .select(['id', 'email'])
    .where('id', 'in', ids)
    .execute();
  return new Map(rows.map((r) => [r.id, r.email]));
}

// Unicode letters, since a registration email can carry them. The local part is capped at its RFC
// length so a long unbroken run (a base64 blob in reasoning) costs linear time, not quadratic.
const EMAIL = /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]{1,64}@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

/** Free text with every email replaced by `[email]`, for a viewer without `assistant.emails`. */
export const redactEmails = (text: string): string => text.replace(EMAIL, '[email]');
