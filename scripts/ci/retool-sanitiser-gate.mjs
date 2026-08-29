#!/usr/bin/env node
/**
 * Mechanical sanitiser gate for `docs/moderator-app/retool-exports/**`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `raw/README.md` documents the sanitisation rules as PROSE. Prose is not a gate.
 * PR #4476 removed three classes of personal data from these exports — staff real
 * names, banned-user IP addresses and end-user account ids — and nothing mechanical
 * stopped the next Retool re-download putting all three back.
 *
 * 🔴 WHAT THIS GATE CANNOT DO — read this before trusting a green run.
 *
 * It cannot detect a *novel* staff real name or a *novel* bare account id. Neither
 * has a shape to match on, which is precisely why both walked straight through the
 * existing shape-based pass: a person's name looks like ordinary prose and an
 * account id looks like any other integer. Catching those requires reading what a
 * query is FOR, which is a human job.
 *
 * So a PASS here means "no KNOWN bad value came back, no out-of-range IP, no
 * credential shape, and the redaction placeholders are intact". It does NOT mean
 * "this export contains no personal data". The `raw/README.md` checklist plus human
 * review remains the control for that half, and this gate is not a substitute for it.
 *
 * FOUR CHECKS
 * -----------
 *  1. denylist   — known-value regression, matched against SALTED HASHES (below)
 *  2. ipv4       — every IPv4 literal must be a documentation/private address
 *  3. credential — the shape rules from `raw/README.md`, as code
 *  4. placeholder— the redaction placeholders must still be present and intact
 *
 * Check 4 is the one that catches the headline risk — a wholesale re-download
 * overwrites a sanitised file, so the placeholders vanish — and it needs no secret.
 *
 * 🔴 WHY THE DENYLIST IS HASHED, AND WHY THE SALT IS NOT COMMITTED
 * A plaintext denylist of staff names in a public repo re-publishes exactly what it
 * exists to protect. Hashing alone is not enough either: the search space for a
 * person's name is tiny, so a committed salt is dictionary-crackable in seconds.
 * The hashes are committed; the salt arrives via $RETOOL_SANITISER_SALT (a CI
 * secret). With no salt the denylist check reports SKIPPED — loudly, and it is not
 * counted as a pass. Checks 2/3/4 need no secret and must never skip.
 *
 * Populate the denylist with:  node scripts/ci/retool-sanitiser-gate.mjs --hash "<value>"
 * (run it locally with the salt exported; paste the digest into the denylist file.
 * Never commit the plaintext.)
 *
 * Exit 0 = pass, 1 = at least one check failed, 2 = the gate itself could not run.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');
export const SCAN_DIR = 'docs/moderator-app/retool-exports';
export const DENYLIST_PATH = 'scripts/ci/retool-sanitiser-denylist.json';

/** Longest n-gram (in words) the denylist can express. "Ada Lovelace Byron" = 3. */
export const MAX_NGRAM_WORDS = 4;

// ---------------------------------------------------------------------------
// check 2 — IPv4 range allowlist
// ---------------------------------------------------------------------------

/**
 * Ranges an export is ALLOWED to contain. RFC5737 is what the redaction replaces
 * real addresses with; the private/loopback/link-local ranges are never a person.
 *
 * Measured against the real exports at the time this landed: the only IPv4-shaped
 * tokens present are the four RFC5737 replacements, so this rule needs no ignore
 * list and a hit is a real finding rather than noise.
 */
const ALLOWED_V4 = [
  [[192, 0, 2], 24], // RFC5737 TEST-NET-1
  [[198, 51, 100], 24], // RFC5737 TEST-NET-2
  [[203, 0, 113], 24], // RFC5737 TEST-NET-3
  [[10], 8], // RFC1918
  [[172, 16], 12], // RFC1918
  [[192, 168], 16], // RFC1918
  [[127], 8], // loopback
  [[169, 254], 16], // link-local
];

const V4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

export function isAllowedIPv4(ip) {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true; // not a valid v4 literal — not ours to judge
  }
  if (octets.every((o) => o === 0) || octets.every((o) => o === 255)) return true;
  const value = octets.reduce((acc, o) => acc * 256 + o, 0);
  return ALLOWED_V4.some(([prefixOctets, bits]) => {
    const padded = [...prefixOctets, 0, 0, 0, 0].slice(0, 4);
    const base = padded.reduce((acc, o) => acc * 256 + o, 0);
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (base & mask) >>> 0;
  });
}

export function findOutOfRangeIPv4(text) {
  const found = [];
  for (const match of text.matchAll(V4_RE)) {
    const octets = [match[1], match[2], match[3], match[4]].map(Number);
    if (octets.some((o) => o > 255)) continue;
    if (!isAllowedIPv4(match[0])) found.push(match[0]);
  }
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------
// check 3 — credential shapes (the `raw/README.md` rules, as code)
// ---------------------------------------------------------------------------

/**
 * A value already redacted is not a finding. Kept deliberately narrow: anything
 * broader starts excusing real secrets that merely mention one of these words.
 */
const REDACTED_RE = /^(?:<[^>]*>|__[A-Z0-9_]+__|\{\{[^}]*\}\}|\$\{[^}]*\}|x{3,}|\*{3,}|REDACTED)$/i;

export const CREDENTIAL_RULES = [
  {
    name: 'bearer-token',
    re: /\bBearer\s+([A-Za-z0-9._~+/=-]{12,})/g,
    describe: 'an Authorization: Bearer value that is not redacted',
  },
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    describe: 'a bare JWT',
  },
  {
    name: 'postgres-dsn',
    re: /\bpostgres(?:ql)?:\/\/[^\s"'<]*:[^\s"'<@]+@[^\s"'<]+/g,
    describe: 'a Postgres connection string carrying a password',
  },
  {
    name: 'stripe-key',
    re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    describe: 'a Stripe-shaped key',
  },
  {
    // The rule the first sanitiser pass was MISSING: match on the assignment, not
    // on the shape of the value. A `const apiKey = '…'` inside a Retool Function
    // body looks like nothing in particular.
    name: 'secret-assignment',
    re: /\b(?:api[_-]?key|apikey|token|secret|password|passwd|auth)\w*\s*[:=]\s*(['"])([^'"\\]{8,})\1/gi,
    describe: 'a secret-named variable assigned a literal value',
    valueGroup: 2,
  },
];

export function findCredentialShapes(text) {
  const found = [];
  for (const rule of CREDENTIAL_RULES) {
    for (const match of text.matchAll(rule.re)) {
      const value = rule.valueGroup ? match[rule.valueGroup] : match[1] ?? match[0];
      if (value && REDACTED_RE.test(value.trim())) continue;
      found.push({ rule: rule.name, describe: rule.describe, sample: truncate(match[0]) });
    }
  }
  return found;
}

function truncate(s) {
  const flat = s.replace(/\s+/g, ' ');
  return flat.length > 48 ? `${flat.slice(0, 45)}…` : flat;
}

// ---------------------------------------------------------------------------
// check 1 — hashed known-value denylist
// ---------------------------------------------------------------------------

/**
 * Whitespace-normalised, lowercased word tokens.
 *
 * 🔴 The normalisation is load-bearing, not cosmetic. During PR #4476's round-3
 * audit two occurrences survived every previous sweep because a line wrap split
 * the token across a comment continuation, so a contiguous grep returned a
 * confident zero. Normalise first, then match.
 */
export function tokenize(text) {
  return text
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function hashValue(salt, value) {
  const normalized = tokenize(value).join(' ');
  return createHash('sha256').update(`${salt}\u0000${normalized}`).digest('hex');
}

/** Every 1..MAX_NGRAM_WORDS word window, hashed. */
export function findDenylistHits(text, { salt, hashes }) {
  const wanted = hashes instanceof Set ? hashes : new Set(hashes);
  if (wanted.size === 0) return [];
  const words = tokenize(text);
  const hits = new Set();
  for (let n = 1; n <= MAX_NGRAM_WORDS; n += 1) {
    for (let i = 0; i + n <= words.length; i += 1) {
      const gram = words.slice(i, i + n).join(' ');
      const digest = createHash('sha256').update(`${salt}\u0000${gram}`).digest('hex');
      if (wanted.has(digest)) hits.add(digest);
    }
  }
  return [...hits];
}

// ---------------------------------------------------------------------------
// check 4 — redaction placeholders must survive
// ---------------------------------------------------------------------------

/**
 * A wholesale re-download overwrites a sanitised file with a raw one, so the
 * placeholders disappear. That is the exact headline risk, and this check catches
 * it without needing any secret.
 */
export const REQUIRED_PLACEHOLDERS = [
  { file: 'raw/user-lookup-v2.json', token: '__MODERATOR_A__' },
  { file: 'raw/bulk-ban.json', token: '203.0.113.' },
  { file: 'bulk-ban.md', token: '203.0.113.' },
];

export function findMissingPlaceholders(readFile) {
  const missing = [];
  for (const { file, token } of REQUIRED_PLACEHOLDERS) {
    const text = readFile(file);
    if (text === null) {
      missing.push({ file, token, reason: 'file is absent' });
    } else if (!text.includes(token)) {
      missing.push({ file, token, reason: 'redaction placeholder is gone' });
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

export function listFiles(root, rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, child));
    else out.push(child);
  }
  return out.sort();
}

export function loadDenylist(root) {
  const abs = path.join(root, DENYLIST_PATH);
  if (!existsSync(abs)) return { hashes: [] };
  const parsed = JSON.parse(readFileSync(abs, 'utf8'));
  return { hashes: Array.isArray(parsed.hashes) ? parsed.hashes : [] };
}

export function runGate({ root = REPO_ROOT, salt = process.env.RETOOL_SANITISER_SALT } = {}) {
  const files = listFiles(root, SCAN_DIR);
  const failures = [];
  const notes = [];

  if (files.length === 0) {
    return {
      ok: false,
      failures: [`${SCAN_DIR} contains no files — the gate scanned nothing`],
      notes,
      files,
    };
  }

  const { hashes } = loadDenylist(root);
  const denylistActive = Boolean(salt) && hashes.length > 0;
  if (!salt) {
    notes.push('denylist SKIPPED — $RETOOL_SANITISER_SALT is not set. Checks 2-4 still ran.');
  } else if (hashes.length === 0) {
    notes.push(`denylist SKIPPED — ${DENYLIST_PATH} lists no hashes yet. Checks 2-4 still ran.`);
  }

  for (const rel of files) {
    const text = readFileSync(path.join(root, rel), 'utf8');

    for (const ip of findOutOfRangeIPv4(text)) {
      failures.push(`${rel}: IPv4 literal ${ip} is outside the documentation/private ranges`);
    }
    for (const hit of findCredentialShapes(text)) {
      failures.push(`${rel}: ${hit.describe} [${hit.rule}] — ${hit.sample}`);
    }
    if (denylistActive) {
      for (const digest of findDenylistHits(text, { salt, hashes })) {
        // Never print the value; printing it here would undo the redaction.
        failures.push(
          `${rel}: a denylisted known-bad value is present (digest ${digest.slice(0, 12)}…)`
        );
      }
    }
  }

  const readScoped = (rel) => {
    const abs = path.join(root, SCAN_DIR, rel);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  };
  for (const miss of findMissingPlaceholders(readScoped)) {
    failures.push(
      `${SCAN_DIR}/${miss.file}: ${miss.reason} (expected ${miss.token}) — a raw re-download would look exactly like this`
    );
  }

  return { ok: failures.length === 0, failures, notes, files, denylistActive };
}

function main(argv) {
  const hashIdx = argv.indexOf('--hash');
  if (hashIdx !== -1) {
    const salt = process.env.RETOOL_SANITISER_SALT;
    const value = argv[hashIdx + 1];
    if (!salt) {
      console.error('--hash needs $RETOOL_SANITISER_SALT exported.');
      return 2;
    }
    if (!value) {
      console.error('usage: --hash "<value to denylist>"');
      return 2;
    }
    console.log(hashValue(salt, value));
    return 0;
  }

  const result = runGate({});
  for (const note of result.notes) console.log(`retool-sanitiser-gate: NOTE ${note}`);
  console.log(`retool-sanitiser-gate: scanned ${result.files.length} file(s) under ${SCAN_DIR}`);
  if (result.ok) {
    console.log(
      'retool-sanitiser-gate: PASS — no known-bad value, out-of-range IP, credential shape or missing placeholder.'
    );
    console.log(
      'retool-sanitiser-gate: this does NOT mean the exports are free of personal data — a novel name or bare account id has no shape to match on. See the header.'
    );
    return 0;
  }
  console.error(`retool-sanitiser-gate: FAIL — ${result.failures.length} finding(s):`);
  for (const failure of result.failures) console.error(`  - ${failure}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
