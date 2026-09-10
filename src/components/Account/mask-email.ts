/**
 * A fixed run of dots, not one per character: the address length is itself a hint when the account
 * page is on a stream or a shared screen.
 */
export function maskEmail(email: string) {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••••';
  return `${email.slice(0, 1)}•••••${email.slice(at)}`;
}
