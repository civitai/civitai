import { existsSync, realpathSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { isIP } from 'net';

import type { DataClass, DecisionState, Hosting, HostKind } from './types';

export class EvalSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalSafetyError';
  }
}

/** Resolves links on the longest existing prefix, without creating anything. */
function realPathOfPrefix(
  absolute: string,
  exists: (path: string) => boolean,
  realpath: (path: string) => string
): string {
  const rest: string[] = [];
  let current = absolute;
  while (!exists(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    rest.unshift(basename(current));
    current = parent;
  }
  return join(realpath(current), ...rest);
}

/**
 * Eval data holds user content, so it must never sit inside a git checkout —
 * this repo is public, and `_local/` is a git repo of its own. Checked on the
 * real path, so a junction or symlink into a checkout is caught.
 */
export function assertDataDirOutsideRepo(
  dataDir: string,
  exists: (path: string) => boolean = existsSync,
  realpath: (path: string) => string = realpathSync.native
): string {
  const absolute = realPathOfPrefix(resolve(dataDir), exists, realpath);
  let current = absolute;
  for (;;) {
    if (exists(resolve(current, '.git'))) {
      throw new EvalSafetyError(
        `--data-dir ${absolute} is inside the git checkout at ${current}; eval data must live outside every repository`
      );
    }
    const parent = dirname(current);
    if (parent === current) return absolute;
    current = parent;
  }
}

function ipv4InPrivateRange(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // CGNAT / tailnet addresses
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Moderation images may only travel to infrastructure we control, so the URL
 * must be loopback, a private address, or a host someone named explicitly. A
 * public DNS name is refused even if it happens to resolve privately —
 * resolution can change, the allowlist cannot.
 */
export function assertPrivateHost(
  rawUrl: string,
  allowedHosts: readonly string[] = []
): { url: URL; kind: HostKind } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EvalSafetyError(`not a URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EvalSafetyError(`unsupported protocol ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowed = allowedHosts.map((h) => h.toLowerCase());
  const family = isIP(host);
  if (host === 'localhost' || host === '::1' || (family === 4 && host.startsWith('127.'))) {
    return { url, kind: 'loopback' };
  }
  if (allowed.includes(host)) return { url, kind: 'allowlisted' };
  if (family === 4 && ipv4InPrivateRange(host)) return { url, kind: 'private' };
  if (family === 6 && /^f[cd][0-9a-f]{2}:/.test(host)) return { url, kind: 'private' };
  throw new EvalSafetyError(
    `${host} is not loopback, a private address, or an allowlisted host; refusing to send eval data there`
  );
}

const PII_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'email', pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { name: 'url', pattern: /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+/i },
  // Scheme-less: a domain followed by a path, e.g. example.com/user/name.
  { name: 'url', pattern: /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S+/i },
  { name: 'handle', pattern: /(?:^|[^\w@])@[A-Za-z0-9_]{2,}/ },
];

/**
 * Independent of each node's own redaction, so a leak needs both to fail.
 * Throws naming the item and the pattern, never the matched text.
 */
export function assertNoPii(itemId: string, state: DecisionState): void {
  for (const [field, value] of Object.entries(state)) {
    for (const { name, pattern } of PII_PATTERNS) {
      if (pattern.test(value)) {
        throw new EvalSafetyError(
          `item ${itemId}: state.${field} contains a ${name}-shaped string; redact it in buildState`
        );
      }
    }
  }
}

/**
 * Which arms may receive a node's data. Moderation images go to a self-hosted
 * arm on loopback or a host named with --allow-host: a bare private range also
 * covers a rented machine on a VPN, which is not infrastructure we control.
 * Text may go to a third party only with zero data retention, which Justin
 * approved on 2026-10-03 once org prompt logging was confirmed off.
 */
export function assertArmAllowed(
  dataClass: DataClass,
  arm: { hosting: Hosting; zeroDataRetention: boolean; hostKind?: HostKind }
): void {
  if (dataClass === 'moderation-image') {
    if (arm.hosting !== 'self-hosted') {
      throw new EvalSafetyError('moderation-image data may only go to a self-hosted arm');
    }
    if (arm.hostKind !== 'loopback' && arm.hostKind !== 'allowlisted') {
      throw new EvalSafetyError(
        'moderation-image data needs a loopback or explicitly allowlisted host, not a bare private range'
      );
    }
    return;
  }
  if (arm.hosting === 'self-hosted') return;
  if (!arm.zeroDataRetention) {
    throw new EvalSafetyError(
      `${dataClass} data may go to a third-party arm only with zero data retention`
    );
  }
}
