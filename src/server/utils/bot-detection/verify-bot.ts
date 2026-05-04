// Verifies a request is from a real search engine crawler by matching the
// client IP against published IP-range JSON snapshots committed in this folder.
// Refresh the JSONs via `refresh-bot-ips.ts`.

import googlebotIps from './googlebot-ips.json';
import googleSpecialIps from './google-special-ips.json';
import bingbotIps from './bingbot-ips.json';

export type VerifiedBot = 'googlebot' | 'bingbot';

const BOT_UA_PATTERNS: Record<VerifiedBot, RegExp> = {
  googlebot:
    /(Googlebot|AdsBot-Google|Mediapartners-Google|FeedFetcher-Google|GoogleOther|Storebot-Google|APIs-Google)/i,
  bingbot: /(bingbot|adidxbot|MicrosoftPreview|BingPreview)/i,
};

// BigInt constants — TS target ES2018 disallows the `Nn` literal syntax,
// so we use the constructor form once and reuse.
const B0 = BigInt(0);
const B1 = BigInt(1);
const B8 = BigInt(8);
const B16 = BigInt(16);
const V4_MASK = BigInt('0xffffffff');

type Cidr = { network: bigint; prefix: number; isV6: boolean };

type PrefixEntry = { ipv4Prefix?: string; ipv6Prefix?: string };

const BOT_CIDRS: Record<VerifiedBot, Cidr[]> = {
  googlebot: parsePrefixes([
    ...(googlebotIps.prefixes as PrefixEntry[]),
    ...(googleSpecialIps.prefixes as PrefixEntry[]),
  ]),
  bingbot: parsePrefixes(bingbotIps.prefixes as PrefixEntry[]),
};

// Dev/test allowlist — IPs in this set bypass the UA + CIDR check and are
// treated as googlebot. Set via `BOT_TEST_IPS=ip1,ip2` in .env.local. Gated
// to non-production so a stray prod env var can't leak the gate.
const TEST_BOT_IPS = new Set(
  process.env.NODE_ENV !== 'production'
    ? (process.env.BOT_TEST_IPS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []
);

function parsePrefixes(entries: PrefixEntry[]): Cidr[] {
  return entries.flatMap((entry) => {
    const cidr = entry.ipv4Prefix ?? entry.ipv6Prefix;
    if (!cidr) return [];
    try {
      return [parseCidr(cidr)];
    } catch {
      return [];
    }
  });
}

function fullMask(totalBits: number): bigint {
  return (B1 << BigInt(totalBits)) - B1;
}

function maskFor(prefix: number, totalBits: number): bigint {
  if (prefix === 0) return B0;
  if (prefix === totalBits) return fullMask(totalBits);
  return fullMask(totalBits) ^ ((B1 << BigInt(totalBits - prefix)) - B1);
}

function parseCidr(cidr: string): Cidr {
  const slash = cidr.indexOf('/');
  if (slash === -1) throw new Error(`Invalid CIDR: ${cidr}`);
  const addr = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  const isV6 = addr.includes(':');
  const totalBits = isV6 ? 128 : 32;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > totalBits) {
    throw new Error(`Invalid CIDR prefix: ${cidr}`);
  }
  const ipBig = ipToBigInt(addr, isV6);
  return { network: ipBig & maskFor(prefix, totalBits), prefix, isV6 };
}

function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`Invalid IPv4: ${ip}`);
  let acc = B0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`Invalid IPv4: ${ip}`);
    acc = (acc << B8) | BigInt(n);
  }
  return acc;
}

function ipv6ToBigInt(ip: string): bigint {
  // Strip zone id (e.g. "fe80::1%eth0")
  const noZone = ip.split('%')[0];

  // Handle IPv4-mapped suffix: "::ffff:1.2.3.4"
  let working = noZone;
  let trailingV4: bigint | null = null;
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const v4Part = working.slice(lastColon + 1);
    trailingV4 = ipv4ToBigInt(v4Part);
    // Replace v4 tail with two zero groups so the v6 expansion math works
    working = working.slice(0, lastColon) + ':0:0';
  }

  // Expand "::"
  const doubleColon = working.indexOf('::');
  let groups: string[];
  if (doubleColon === -1) {
    groups = working.split(':');
  } else {
    const head = working.slice(0, doubleColon);
    const tail = working.slice(doubleColon + 2);
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const fillCount = 8 - headParts.length - tailParts.length;
    if (fillCount < 0) throw new Error(`Invalid IPv6: ${ip}`);
    groups = [...headParts, ...Array<string>(fillCount).fill('0'), ...tailParts];
  }
  if (groups.length !== 8) throw new Error(`Invalid IPv6: ${ip}`);

  let acc = B0;
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) throw new Error(`Invalid IPv6: ${ip}`);
    acc = (acc << B16) | BigInt(n);
  }

  if (trailingV4 !== null) {
    // Replace last 32 bits with the parsed trailing v4 value
    acc = (acc & ~V4_MASK) | trailingV4;
  }

  return acc;
}

function ipToBigInt(ip: string, isV6: boolean): bigint {
  return isV6 ? ipv6ToBigInt(ip) : ipv4ToBigInt(ip);
}

function ipMatchesCidr(ipBig: bigint, isV6: boolean, cidr: Cidr): boolean {
  if (isV6 !== cidr.isV6) return false;
  const totalBits = isV6 ? 128 : 32;
  return (ipBig & maskFor(cidr.prefix, totalBits)) === cidr.network;
}

/**
 * Identify the request as a verified search-engine crawler.
 *
 * Two-step check:
 *   1. UA matches a known crawler pattern (cheap string test, filters >99% of traffic).
 *   2. Client IP falls within the published CIDR ranges for that crawler.
 *
 * Returns `null` if either check fails — including UA-matches-but-IP-doesn't, which
 * we treat as a forgery (real crawlers always come from their published ranges).
 */
export function verifyBot(
  ua: string | null | undefined,
  ip: string | null | undefined
): VerifiedBot | null {
  if (!ip) return null;

  if (TEST_BOT_IPS.has(ip)) return 'googlebot';

  if (!ua) return null;

  let parsedIp: { big: bigint; isV6: boolean };
  try {
    const isV6 = ip.includes(':');
    parsedIp = { big: ipToBigInt(ip, isV6), isV6 };
  } catch {
    return null;
  }

  for (const name of Object.keys(BOT_UA_PATTERNS) as VerifiedBot[]) {
    if (!BOT_UA_PATTERNS[name].test(ua)) continue;
    const cidrs = BOT_CIDRS[name];
    for (const cidr of cidrs) {
      if (ipMatchesCidr(parsedIp.big, parsedIp.isV6, cidr)) return name;
    }
    // UA claims this bot but IP is outside the published ranges → forgery
    return null;
  }
  return null;
}
