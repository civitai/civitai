/**
 * Sign-in and email-change flows accept only a plain `local@domain` address in printable ASCII:
 * no display names, comments, quoting, lists or whitespace. An internationalised domain is
 * accepted in its punycode (`xn--`) form.
 *
 * `parse` is the address parser of the transport that sends the mail (nodemailer's
 * `addressparser`), injected so each app checks with the version it sends with.
 */
export type AddressParser = (input: string) => ReadonlyArray<{ address?: string; group?: unknown }>;

const NON_PLAIN_CHARS = /[\s()<>,;:\\"[\]]/;
const NON_ASCII = /[^\x21-\x7E]/;

/**
 * The address as the transport reads it, or `null` when the input is not a plain address.
 * Checks on the address (its domain above all) read the returned value.
 */
export function parsePlainEmailAddress(input: string, parse: AddressParser): string | null {
  const email = input.trim();
  if (!email || NON_PLAIN_CHARS.test(email) || NON_ASCII.test(email)) return null;

  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return null;
  // One trailing dot is the DNS root and is accepted; every other label must be non-empty.
  const domain = email.slice(at + 1).replace(/\.$/, '');
  if (!domain || domain.split('.').some((label) => !label)) return null;

  const parsed = parse(email);
  if (parsed.length !== 1) return null;
  const [entry] = parsed;
  if (entry.group !== undefined || typeof entry.address !== 'string') return null;

  const address = entry.address.trim();
  return address.toLowerCase() === email.toLowerCase() ? address : null;
}
