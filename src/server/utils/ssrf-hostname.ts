/**
 * SSRF lexical hostname/IP guards — the PURE, dependency-free half of the SSRF
 * defense. NO `node:dns`, NO `fetch`, NO env: safe to pull into a client bundle
 * (e.g. `block-manifest-validator.service` is imported by `ManifestEditForm.tsx`).
 *
 * `PRIVATE_HOSTNAME_PATTERNS` + `isPublicHttpsUrl` were EXTRACTED verbatim from
 * `block-manifest-validator.service.ts` (which now imports them from here) so the
 * manifest validator, the read-path anchors, and the fetch-time guard in
 * `safe-fetch.ts` all share ONE source of truth and can't drift.
 *
 * ⚠️ These are PURELY LEXICAL — they do NOT DNS-resolve, so they do NOT catch
 * DNS-rebinding (a public name that resolves to 127.0.0.1 at fetch time). Any
 * server-side FETCH of a user-supplied URL MUST additionally resolve the host and
 * run every resolved address through {@link isPrivateIp} at fetch time — that is
 * exactly what `safe-fetch.ts` does. `isPrivateIp` lives here (pure) so both the
 * fetch guard and its unit tests can import it without the `node:dns` graph.
 */

// SSRF gate for a user-supplied URL host. The migrate-once-fix-forward move is to
// reject hostnames that resolve to private/loopback ranges. We can't DNS-resolve
// at LEXICAL validation time, so we use a hostname denylist of shapes we know are
// non-public (localhost / RFC1918 / link-local / metadata service endpoints).
export const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  // Full IPv6 ULA range fc00::/7 — the spec is fc00::/7, not fc00::/8.
  // Previously only fc00: matched; widen to fc00-fdff.
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
  // IPv6 with a zone identifier (RFC 6874 `%`-encoded) — sometimes accepted
  // by URL parsers and lets an attacker pin a literal zone like %eth0.
  /%/,
  // Reserved internal infrastructure names commonly used internally.
  /\.internal$/i,
  /\.local$/i,
  /^metadata\.google\.internal$/i,
  // Note: punycode/IDN homograph attacks (e.g. `xn--...` registered as a
  // look-alike) and DNS-rebinding (public name flipped to 127.0.0.1 at
  // fetch time) are NOT caught by lexical validation. A server-side fetch of
  // this URL MUST re-validate at fetch time (DNS-resolve + isPrivateIp) and
  // disable redirect-follow — see safe-fetch.ts.
];

export function isPublicHttpsUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'must be https' };
  const hostname = url.hostname;

  // Single-string IPv4 literals (audit B4): WHATWG URL accepts dot-less
  // forms like `0x7f000001` and `2130706433` (the integer form of 127.0.0.1)
  // and parses them to the corresponding IPv4 address. Reject these BEFORE
  // the dotted-name check below, because they don't contain dots.
  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    return { ok: false, reason: 'hex IPv4 literal not permitted' };
  }
  if (/^[0-9]+$/.test(hostname)) {
    // Pure-integer form. Includes `2130706433` (= 127.0.0.1) and similar.
    return { ok: false, reason: 'integer IPv4 literal not permitted' };
  }

  // IPv4-mapped IPv6 ([::ffff:127.0.0.1] and similar) — WHATWG URL surfaces
  // these as `[::ffff:7f00:1]` style in `hostname` (lowercased, square
  // brackets kept when URL.host includes them — URL.hostname strips them).
  // Reject anything containing `::ffff:` (the IPv4-mapped prefix).
  if (/::ffff:/i.test(hostname)) {
    return { ok: false, reason: 'IPv4-mapped IPv6 not permitted' };
  }

  if (!hostname.includes('.') || hostname.endsWith('.')) {
    return { ok: false, reason: 'hostname must be a public dotted name' };
  }
  for (const re of PRIVATE_HOSTNAME_PATTERNS) {
    if (re.test(hostname)) return { ok: false, reason: 'private/internal hostname' };
  }
  // Pure-decimal-dotted IPv4 literals — keep the surface narrow even for
  // public addresses; manifests should always load by DNS name.
  if (/^[0-9.]+$/.test(hostname)) {
    return { ok: false, reason: 'literal IPv4 addresses are not permitted' };
  }
  // Dotted hex/octal IPv4 literals (e.g. 0x7f.0x0.0x0.0x1, 0177.0.0.1).
  if (/^0x[0-9a-f]+(\.0x[0-9a-f]+)+$/i.test(hostname)) {
    return { ok: false, reason: 'hex IPv4 literals are not permitted' };
  }
  if (/^0[0-7]+(\.[0-7]+)+$/.test(hostname)) {
    return { ok: false, reason: 'octal IPv4 literals are not permitted' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// isPrivateIp — the FETCH-TIME guard applied to every DNS-resolved address.
// Pure (no I/O) so both safe-fetch.ts and its unit tests can import it.
// Fail CLOSED: an unparseable address is treated as private (unsafe).
// ---------------------------------------------------------------------------

/** True if a dotted-quad IPv4 string is in a private / loopback / reserved range. */
function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return true; // not a dotted-quad → fail closed
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255 broadcast
  return false;
}

/**
 * Expand an IPv6 textual address into its 8 hextet numbers, or null if it can't
 * be parsed. Handles `::` compression and an IPv4-mapped/embedded dotted tail
 * (`::ffff:127.0.0.1`, `::127.0.0.1`).
 */
function expandIpv6(input: string): number[] | null {
  let a = input;

  // Fold a trailing dotted-quad (IPv4-mapped / -embedded) into two hextets.
  const v4 = a.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4 && v4.index !== undefined) {
    const octs = v4[1].split('.').map(Number);
    if (octs.length !== 4 || octs.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octs[0] << 8) | octs[1]).toString(16);
    const lo = ((octs[2] << 8) | octs[3]).toString(16);
    a = a.slice(0, v4.index) + hi + ':' + lo;
  }

  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  let groups: string[];
  if (halves.length === 2) {
    const tail = halves[1] === '' ? [] : halves[1].split(':');
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (g === '' ? NaN : parseInt(g, 16)));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

/** True if an IPv6 string is loopback / ULA / link-local / multicast / mapped-private. */
function isPrivateIpv6(addr: string): boolean {
  if (addr.includes('%')) return true; // zone id (link-local) → reject
  const g = expandIpv6(addr.toLowerCase());
  if (!g) return true; // unparseable → fail closed
  // ::1 loopback / :: unspecified
  if (g.slice(0, 7).every((h) => h === 0) && (g[7] === 0 || g[7] === 1)) return true;
  const firstByte = g[0] >> 8;
  if ((firstByte & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return true; // fe80::/10 link-local
  if (firstByte === 0xff) return true; // ff00::/8 multicast
  // ::ffff:a.b.c.d IPv4-mapped → check the embedded IPv4.
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0xffff
  ) {
    return isPrivateIpv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  // ::a.b.c.d IPv4-compatible (deprecated) → check the embedded IPv4.
  if (g.slice(0, 6).every((h) => h === 0) && (g[6] !== 0 || g[7] !== 0)) {
    return isPrivateIpv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052) — the low 32 bits embed an
  // IPv4 dest a NAT64 translator will reach. `64:ff9b::a9fe:a9fe` embeds
  // 169.254.169.254, so the embedded v4 MUST be run through the v4 guard.
  if (
    g[0] === 0x0064 &&
    g[1] === 0xff9b &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0
  ) {
    return isPrivateIpv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  // 6to4 2002::/16 (RFC 3056) — the next 32 bits after the 2002 prefix embed the
  // IPv4 of the 6to4 relay/host; reject if that embedded v4 is private/reserved.
  if (g[0] === 0x2002) {
    return isPrivateIpv4(`${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`);
  }
  return false;
}

/**
 * True if `addr` (a DNS-resolved IPv4 or IPv6 literal) is in a
 * private / loopback / link-local / unique-local / metadata / reserved range and
 * must NOT be fetched. Fail CLOSED — an address we can't parse is treated as
 * private. This is the fetch-time complement to the lexical hostname guard that
 * closes the DNS-rebinding hole.
 */
export function isPrivateIp(addr: string): boolean {
  return addr.includes(':') ? isPrivateIpv6(addr) : isPrivateIpv4(addr);
}
