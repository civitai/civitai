/**
 * Sign-in and email-change flows accept only a plain `local@domain` address.
 *
 * Mail transports read an address field with a full RFC 5322 parser, which understands display
 * names, comments, quoting and lists. An input that only a full parser understands can be read one
 * way by our checks and another way by the transport, so anything beyond a plain address is refused.
 *
 * `parse` is the address parser of the transport that will deliver the mail (nodemailer's
 * `addressparser`), injected so each app checks with the exact version it sends with.
 */
export type AddressParser = (input: string) => ReadonlyArray<{ address?: string; group?: unknown }>;

const NON_PLAIN_CHARS = /[\s()<>,;:\\"[\]]/;

/**
 * The address the transport would deliver to, or `null` when the input is not a plain address.
 *
 * Derive anything checked about the address (its domain above all) from the returned value, not
 * from the input.
 */
export function parsePlainEmailAddress(input: string, parse: AddressParser): string | null {
  const email = input.trim();
  if (!email || NON_PLAIN_CHARS.test(email)) return null;

  const parsed = parse(email);
  if (parsed.length !== 1) return null;
  const [entry] = parsed;
  if (entry.group !== undefined || typeof entry.address !== 'string') return null;

  const address = entry.address.trim();
  return address.toLowerCase() === email.toLowerCase() ? address : null;
}
