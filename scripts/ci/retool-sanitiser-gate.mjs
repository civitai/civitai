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

// Rejects a dotted quad that is part of a LONGER dotted run — `1.2.3.4.5` is a
// version string, not an address.
//
// 🔴 The lookahead must be `(?!\.?\d)`, NOT `(?![\d.])`. The stricter form also
// rejected a trailing sentence period, so `Banned the account at 8.8.8.8.` went
// UNDETECTED — and half this corpus is markdown prose where that is the natural
// way to write it. Narrowing a false positive into a false negative, on exactly
// the class the gate exists for.
const V4_RE = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g;

/**
 * IPv6. The exports have never legitimately carried one, so any real address is a
 * finding — the risk this gate exists for is "end-user IP addresses", which was
 * never a v4-only statement.
 *
 * The pattern is deliberately LOOSE and `findIPv6` decides; three revisions tried
 * to be precise here and each traded one defect for another:
 *
 *  - EMPTY groups (`{0,4}`) are what let `::` appear anywhere and let a match
 *    absorb a multi-group tail. Requiring non-empty groups missed the entire
 *    `X::Y` family (`fe80::1`, `fe80::a00:27ff:fe4e:66a1`) while three separate
 *    places claimed no IPv6 survives.
 *  - The BOUNDARIES are what reject a Postgres cast: `id::date` yields `d::da`,
 *    a perfectly well-formed "address", and these exports are full of SQL. The
 *    character before the candidate is a word character, so the cast is dropped
 *    while a standalone address is not.
 *  - The trailing boundary must still permit a SENTENCE PERIOD. `(?![\w:.])`
 *    rejected it, so `Banned the account from fe80::1.` went undetected — the
 *    exact mirror of the V4 defect, and 21 of the 32 scanned files are prose.
 *  - The leading boundary omits `:` so a bare `ip:2001:db8::1` still matches.
 */
const V6_RE = /(?<![\w.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])(?!\.[0-9a-f])/gi;

/** `::` and `::1` are unspecified/loopback — never a person. */
const ALLOWED_V6 = new Set(['::', '::1']);

/**
 * A match is a real address only if it is compressed (`::`) or full-length (8
 * groups). Everything else the pattern can reach — `12:30:45`, `17:28:00Z` — is
 * ordinary colon-separated text.
 *
 * 🔴 There is NO `groups.length < 2` filter, and adding one was a mistake worth
 * recording. It was introduced to stop Postgres casts, but the BOUNDARIES alone
 * already do that — measured: with the filter removed, `select id::date from t`
 * still yields `[]` and the real corpus still passes. Its only observable effects
 * were bad ones: it silently exempted every single-group address (`fe80::`,
 * `::dead` went unreported while the README said any IPv6 is rejected), and it
 * consumed `::1` before `ALLOWED_V6` could see it — making that Set dead code
 * whose docstring read as live coverage, and making its test vacuous. Deleting
 * three separate things left the suite green, which is how it was found.
 */
export function findIPv6(text) {
  const found = [];
  for (const match of text.matchAll(V6_RE)) {
    const literal = match[0];
    if (!literal.includes('::') && literal.split(':').length !== 8) continue;
    if (ALLOWED_V6.has(literal.toLowerCase())) continue;
    found.push(literal);
  }
  return [...new Set(found)];
}

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
    // `i`: the auth scheme is case-insensitive per RFC 7235, so `bearer …` and
    // `BEARER …` are equally valid and were both walking past this rule.
    re: /\bBearer\s+([A-Za-z0-9._~+/=-]{12,})/gi,
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
    //
    // 🔴 The first version of this rule only covered `ident = '…'` — the SINGLE-quoted
    // JS form. But the corpus it scans is eleven Retool JSON exports, where the
    // dominant serialisations are `"apiKey": "…"` (quoted key) and the transit pair
    // `"KEY","value"`, and neither was caught. A rule that misses the dominant shape
    // of the files it scans is a false-negative surface, not a guard.
    //
    // So: the identifier may be quoted, the separator may be `:`/`=`/`,`, and the
    // value may be single, double or backtick quoted, with `\"` escapes allowed
    // inside (escaped JS embedded in JSON is exactly how the original miss happened).
    // 🔴 The value body must exclude BOTH quote characters and newlines, and be
    // length-bounded. A first attempt used `(?:\\.|[^\\])*?` with a backreference
    // and included backticks in the quote class: in an 11-file JSON corpus where
    // backticks are rare, one opener ran to end-of-file and reported a 646,934-char
    // "secret" in three files. A guard that matches everything is not a guard.
    //
    // `[\w$]*?` before the keyword, because the secret-named identifier is usually a
    // COMPONENT of a longer name — `WEBHOOK_TOKEN`, `stripeSecretKey`. A leading `\b`
    // cannot match `TOKEN` there: the character before it is `_`, which is a word
    // character, so there is no boundary and the dominant Retool config-var shape
    // walked straight past.
    //
    // 🔴 But the keyword must END the identifier — `(?![a-z])`, plus an optional
    // plural `s`. Without it the
    // prefix widener flagged `author`, `authorName`, `authorEmail`, `authorized`
    // and `tokenizer`, a false-positive class the narrower rule never had. These
    // exports will carry `author*` keys on the next re-download of any app that
    // queries models or articles, and a gate that cries wolf gets ignored.
    //
    // 🔴 Bound raised from 200: long OPAQUE tokens are the likeliest real finding
    // and were falling off the top silently (a real JWT is rescued by the `jwt`
    // rule's dot structure; an opaque session token has nothing behind it). The
    // runaway that motivated the bound is prevented by the character class — the
    // value cannot contain a quote, a backslash-quote or a newline — not by 200.
    //
    // 🔴 The `,` separator is DELIBERATELY GONE, reverting part of the previous
    // round. It was added for Retool's transit `"KEY","value"` pair, but `,` cannot
    // be told apart from an ordinary array: `{"tags": ["auth","authentication"]}`
    // and `{"columns": ["password","created_at_utc"]}` are the SAME shape, and both
    // are realistic in these exports. Measured before reverting — every comma-form
    // instance in the real corpus is `"token","{{ retoolContext.configVars.… }}"`,
    // a template reference already skipped as redacted, so the separator caught
    // nothing real while adding a false-positive class. The JSON key form
    // `"token": "…"` is still covered by `:`.
    name: 'secret-assignment',
    // 🔴 NO `i` FLAG, deliberately. `(?![a-z])` under `i` would also reject UPPERCASE,
    // so the anchor killed `stripeSecretKey` via its own `K` — the rule was
    // narrowed on exactly the compound names the widening existed for. Case-based
    // boundary logic and a case-insensitive flag cannot coexist, so the casings are
    // enumerated and the anchor is genuinely case-sensitive.
    re: /(?:^|[^\w$])\\?["']?[\w$]*?(?:API[_-]?KEY|API[_-]?Key|Api[_-]?Key|Api[_-]?key|api[_-]?Key|api[_-]?key|APIKEY|APIKey|ApiKey|Apikey|apiKey|apikey|AUTHORIZATION|Authorization|authorization|AUTHENTICATION|Authentication|authentication|SECRETKEY|SecretKey|secretKey|secretkey|TOKEN|Token|token|SECRET|Secret|secret|PASSWORD|Password|password|PASSWD|Passwd|passwd|AUTH|Auth|auth)s?(?![a-z])[\w$]*\\?["']?\s*[:=]\s*\\?(["'])((?:\\[^"'\n]|[^"'\\\n]){8,4096}?)\\?\1/g,
    describe: 'a secret-named variable assigned a literal value',
    valueGroup: 2,
  },
  {
    // Same widening as its sibling: without it `WEBHOOK_TOKEN = \`…\`` was missed
    // by BOTH rules, so the compound-name case this round justified only worked
    // for quoted values.
    name: 'secret-assignment-template',
    re: /(?:^|[^\w$])[\w$]*?(?:API[_-]?KEY|API[_-]?Key|Api[_-]?Key|Api[_-]?key|api[_-]?Key|api[_-]?key|APIKEY|APIKey|ApiKey|Apikey|apiKey|apikey|AUTHORIZATION|Authorization|authorization|AUTHENTICATION|Authentication|authentication|SECRETKEY|SecretKey|secretKey|secretkey|TOKEN|Token|token|SECRET|Secret|secret|PASSWORD|Password|password|PASSWD|Passwd|passwd|AUTH|Auth|auth)s?(?![a-z])[\w$]*\s*[:=]\s*`([^`\n]{8,4096})`/g,
    describe: 'a secret-named variable assigned a template-literal value',
    valueGroup: 1,
  },
];

/** Strips the escaping that survives a JSON-embedded JS string. */
function unescapeValue(raw) {
  return raw.replace(/\\(["'`\\])/g, '$1');
}

/**
 * There is deliberately no separate minimum-length filter, and the reasoning is
 * NOT uniform across the two rules — the earlier version of this comment claimed
 * it was, which was wrong for one of them:
 *
 *  - `secret-assignment` — genuinely unreachable. `{8,4096}` counts REPETITIONS of
 *    the value alternation and each repetition unescapes to at least one
 *    character, so the unescaped value can never fall below the floor.
 *  - `secret-assignment-template` — the quantifier counts CHARACTERS inside
 *    `[^`\n]`, backslashes included, so an 8-char match can unescape to fewer. A
 *    floor would therefore fire here. It is still omitted: the effect is at most a
 *    slightly over-eager finding on a contrived value, and an over-eager
 *    credential finding is the safe direction.
 *
 * A guard no input can reach reads as coverage while providing none, which is why
 * the first one was deleted rather than left in place.
 */
export function findCredentialShapes(text) {
  const found = [];
  for (const rule of CREDENTIAL_RULES) {
    for (const match of text.matchAll(rule.re)) {
      const raw = rule.valueGroup ? match[rule.valueGroup] : match[1] ?? match[0];
      const value = raw ? unescapeValue(raw) : raw;
      if (value && REDACTED_RE.test(value.trim())) continue;
      found.push({ rule: rule.name, describe: rule.describe, sample: mask(value ?? match[0]) });
    }
  }
  return found;
}

/**
 * 🔴 NEVER print a matched value. This repo is PUBLIC, so an Actions log is
 * world-readable and outlives any force-push that removes the value from the
 * branch — and a banned-user IP is exactly the class this gate exists to keep out.
 *
 * The first version of this file withheld the DENYLIST value for precisely this
 * reason and then printed IPs and Bearer tokens one branch up. A length plus a
 * salt-free digest prefix identifies the finding for whoever has the file open,
 * without republishing it.
 */
export function mask(value) {
  const flat = String(value).replace(/\s+/g, ' ');
  const digest = createHash('sha256').update(flat).digest('hex').slice(0, 8);
  return `${flat.length} chars, sha256:${digest}…`;
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

/**
 * 🔴 Refuses a value the MATCHER structurally cannot find.
 *
 * `findDenylistHits` only builds 1..MAX_NGRAM_WORDS windows, but nothing stopped
 * `--hash` emitting a digest for a longer value. The operator would paste it,
 * commit it, and the denylist would silently never fire for that value — the
 * reassuring-zero shape, inside the very tool that populates the gate.
 */
export function hashValue(salt, value) {
  const words = tokenize(value);
  if (words.length === 0) {
    throw new Error('refusing to hash a value with no word tokens');
  }
  if (words.length > MAX_NGRAM_WORDS) {
    throw new Error(
      `refusing to hash a ${words.length}-token value: findDenylistHits only builds ` +
        `1..${MAX_NGRAM_WORDS}-word windows, so this digest could never match. Hash a ` +
        `distinctive ${MAX_NGRAM_WORDS}-token-or-shorter substring instead.`
    );
  }
  const normalized = words.join(' ');
  return createHash('sha256').update(`${salt}\u0000${normalized}`).digest('hex');
}

/**
 * Public, meaningless string whose digest UNDER THE REAL SALT proves that the salt
 * CI supplies is the one the committed hashes were generated with.
 *
 * 🔴 Nothing else detects a desync. A rotated salt, a regenerated denylist, or a
 * trailing newline in the secret (GitHub preserves it) each leave the check
 * "active", matching nothing, printing nothing, and exiting 0 — under a PASS line
 * asserting "no known-bad value", which it has not established.
 */
export const SENTINEL_VALUE = 'retool sanitiser sentinel';

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
 * placeholders disappear. That is the headline risk, and this check catches it
 * without needing any secret.
 *
 * 🔴 THE LEDGER MUST BE AS WIDE AS THE CLAIM. The first version listed three
 * entries — `__MODERATOR_A__` once and `203.0.113.` twice — while PR #4476 wrote
 * FIVE token classes across 10 occurrences. `__MODERATOR_B__`, `__MODERATOR_C__`
 * and `<accountId>` were guarded by nothing, and `<accountId>` is the one
 * documented class with no other check behind it: a real IP is caught by check 2,
 * but a bare account id is an ordinary integer that only this ledger can see.
 * Restoring two staff names and five account ids passed the whole gate, rc=0.
 *
 * EXPECTED COUNTS, not mere presence. Presence is satisfied by one surviving
 * token, so a PARTIAL re-introduction — some occurrences reverted, one left —
 * reads as clean. Counts make that visible. A count that legitimately changes is
 * a deliberate edit to these exports, which is exactly when a human should look.
 */
export const REQUIRED_PLACEHOLDERS = [
  { file: 'raw/user-lookup-v2.json', token: '__MODERATOR_A__', count: 2 },
  { file: 'raw/user-lookup-v2.json', token: '__MODERATOR_B__', count: 2 },
  { file: 'raw/user-lookup-v2.json', token: '__MODERATOR_C__', count: 2 },
  { file: 'raw/bulk-ban.json', token: '<accountId>', count: 5 },
  { file: 'raw/bulk-ban.json', token: '203.0.113.', count: 4 },
  { file: 'bulk-ban.md', token: '<accountId>', count: 5 },
  { file: 'bulk-ban.md', token: '203.0.113.', count: 4 },
];

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

export function findMissingPlaceholders(readFile) {
  const missing = [];
  for (const { file, token, count } of REQUIRED_PLACEHOLDERS) {
    const text = readFile(file);
    if (text === null) {
      missing.push({ file, token, reason: 'file is absent' });
      continue;
    }
    const seen = countOccurrences(text, token);
    if (seen === 0) {
      missing.push({ file, token, reason: 'redaction placeholder is gone' });
    } else if (seen !== count) {
      missing.push({
        file,
        token,
        reason: `expected ${count} occurrence(s) of this redaction placeholder, found ${seen}`,
      });
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
  if (!existsSync(abs)) return { hashes: [], sentinel: null };
  const parsed = JSON.parse(readFileSync(abs, 'utf8'));
  return {
    hashes: Array.isArray(parsed.hashes) ? parsed.hashes : [],
    sentinel: typeof parsed.sentinel === 'string' && parsed.sentinel ? parsed.sentinel : null,
  };
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

  const { hashes, sentinel } = loadDenylist(root);
  // A trailing newline is the commonest way a pasted CI secret differs from the
  // salt the hashes were built with; GitHub preserves it. Trim, then PROVE it.
  const effectiveSalt = typeof salt === 'string' ? salt.trim() : salt;
  let denylistActive = Boolean(effectiveSalt) && hashes.length > 0;

  if (!effectiveSalt) {
    notes.push('denylist SKIPPED — $RETOOL_SANITISER_SALT is not set. Checks 2-4 still ran.');
  } else if (hashes.length === 0) {
    notes.push(`denylist SKIPPED — ${DENYLIST_PATH} lists no hashes yet. Checks 2-4 still ran.`);
  } else if (!sentinel) {
    notes.push(
      `denylist ACTIVE but UNVERIFIED — ${DENYLIST_PATH} carries no "sentinel", so a ` +
        'salt/hash desync would be undetectable. Regenerate it with --sentinel.'
    );
  } else if (hashValue(effectiveSalt, SENTINEL_VALUE) !== sentinel) {
    // 🔴 Fail, never skip. The hashes are real, the salt is wrong, and every one
    // of them would silently match nothing — a PASS asserting "no known-bad
    // value" it never established.
    denylistActive = false;
    failures.push(
      `${DENYLIST_PATH}: the salt in $RETOOL_SANITISER_SALT does not match the one these ` +
        'hashes were generated with (sentinel digest mismatch), so the denylist would ' +
        'silently match nothing. Fix the secret or regenerate the denylist.'
    );
  }

  for (const rel of files) {
    const text = readFileSync(path.join(root, rel), 'utf8');

    for (const ip of findOutOfRangeIPv4(text)) {
      // 🔴 mask(), like every other branch. A banned-user IP is the single class
      // this gate exists to keep out of a public repo, and it was the one value
      // printed raw — into an Actions log that is world-readable and outlives any
      // force-push. The `::error` annotations added alongside made it MORE visible.
      failures.push(`${rel}: IPv4 literal ${mask(ip)} is outside the documentation/private ranges`);
    }
    for (const ip of findIPv6(text)) {
      failures.push(`${rel}: IPv6 literal ${mask(ip)} — these exports carry no legitimate IPv6`);
    }
    for (const hit of findCredentialShapes(text)) {
      failures.push(`${rel}: ${hit.describe} [${hit.rule}] — ${hit.sample}`);
    }
    if (denylistActive) {
      for (const digest of findDenylistHits(text, { salt: effectiveSalt, hashes })) {
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

/**
 * GitHub renders `::error` / `::warning` as annotations on the PR. A bare
 * console.log is invisible on a green check, which is how "reports SKIPPED
 * loudly" turned out to mean "buried in a log nobody opens".
 */
// 🔴 The annotation must point at the file that actually regressed. Hardcoding
// DENYLIST_PATH pinned every finding to line 1 of the denylist, pointing a
// reviewer AWAY from the export that changed. Every failure string already starts
// with its own path, so recover it.
export const annotate = (level, message, inActions = process.env.GITHUB_ACTIONS === 'true') => {
  if (!inActions) return `retool-sanitiser-gate: ${level.toUpperCase()} ${message}`;
  const [, file] = /^([\w./-]+):\s/.exec(message) ?? [];
  return `::${level} file=${file ?? DENYLIST_PATH}::${message}`;
};

/**
 * The scope a PASS line is allowed to claim. Exported so it can be tested: the
 * round that introduced it left it unguarded, and a mutant forcing the full-scope
 * string stayed green — in a change whose entire premise was a PASS asserting a
 * scope it had not established.
 */
export const passScope = (denylistActive) =>
  denylistActive
    ? 'no known-bad value, out-of-range IP, credential shape or missing placeholder'
    : 'no out-of-range IP, credential shape or missing placeholder (THE DENYLIST DID NOT RUN)';

function main(argv) {
  const salt = process.env.RETOOL_SANITISER_SALT?.trim();

  if (argv.includes('--sentinel')) {
    if (!salt) {
      console.error('--sentinel needs $RETOOL_SANITISER_SALT exported.');
      return 2;
    }
    console.log(hashValue(salt, SENTINEL_VALUE));
    return 0;
  }

  const hashIdx = argv.indexOf('--hash');
  if (hashIdx !== -1) {
    const value = argv[hashIdx + 1];
    if (!salt) {
      console.error('--hash needs $RETOOL_SANITISER_SALT exported.');
      return 2;
    }
    if (!value) {
      console.error('usage: --hash "<value to denylist>"');
      return 2;
    }
    try {
      console.log(hashValue(salt, value));
    } catch (error) {
      console.error(`retool-sanitiser-gate: ${error.message}`);
      return 2;
    }
    return 0;
  }

  const result = runGate({});
  for (const note of result.notes) console.log(annotate('warning', note));
  console.log(`retool-sanitiser-gate: scanned ${result.files.length} file(s) under ${SCAN_DIR}`);
  if (result.ok) {
    console.log(`retool-sanitiser-gate: PASS — ${passScope(result.denylistActive)}.`);
    console.log(
      'retool-sanitiser-gate: this does NOT mean the exports are free of personal data — a novel name or bare account id has no shape to match on. See the header.'
    );
    return 0;
  }
  console.error(`retool-sanitiser-gate: FAIL — ${result.failures.length} finding(s):`);
  for (const failure of result.failures) console.error(annotate('error', failure));
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
