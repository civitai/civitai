/**
 * A fresh id for one Buzz grant/deduct form. Resubmitting the same form reuses it, so the server can
 * find a transaction whose response was lost instead of filing it again. Hex, 32 chars.
 */
export function newBuzzSubmissionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
