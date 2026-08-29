import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_RULES,
  DENYLIST_PATH,
  SCAN_DIR,
  findCredentialShapes,
  findDenylistHits,
  findMissingPlaceholders,
  findOutOfRangeIPv4,
  hashValue,
  isAllowedIPv4,
  runGate,
  tokenize,
} from '../ci/retool-sanitiser-gate.mjs';

/**
 * `scripts/ci/retool-sanitiser-gate.mjs` blocks a Retool re-download from putting
 * personal data back into `docs/moderator-app/retool-exports/**`.
 *
 * Its whole value rests on being UNABLE to report a confident pass, so every case
 * here asserts BOTH directions: the gate goes red on a planted value AND names the
 * specific rule that caught it. A test that only asserted "did not pass" would be
 * satisfied by a gate failing for the wrong reason — and three of these four checks
 * can fail for each other's reasons if the fixtures are careless (an out-of-range IP
 * planted into a file that ALSO lost its placeholder dies to whichever runs first).
 * So each fixture tree is mutated in exactly ONE dimension.
 *
 * The denylist fixtures use a salt and values invented here. No real salt and no
 * real redacted value appears in this file, which is the same reason the denylist
 * ships as hashes: this repo is public.
 */

// Built by concatenation so this test file's own source can never be mistaken for
// a real finding by a future repo-wide scan.
const FAKE_SECRET = `AKIA${'QQQ'}12345678ZZ`;
const PUBLIC_DNS_IP = [8, 8, 8, 8].join('.');

const SALT = 'fixture-salt-not-the-real-one';
const DENIED_NAME = 'Ada Lovelace';

let root: string;

/** A minimal but STRUCTURALLY REAL export tree: placeholders present, IPs in RFC5737. */
function seedCleanTree(dir: string) {
  const raw = path.join(dir, SCAN_DIR, 'raw');
  mkdirSync(raw, { recursive: true });
  writeFileSync(
    path.join(raw, 'user-lookup-v2.json'),
    JSON.stringify({ gate: "current_user.fullName === '__MODERATOR_A__'" }, null, 2)
  );
  writeFileSync(
    path.join(raw, 'bulk-ban.json'),
    JSON.stringify({ sql: 'WHERE ip IN (203.0.113.1, 203.0.113.2)' }, null, 2)
  );
  writeFileSync(path.join(dir, SCAN_DIR, 'bulk-ban.md'), '| ip |\n| 203.0.113.1 |\n');
  writeFileSync(path.join(dir, DENYLIST_PATH), JSON.stringify({ version: 1, hashes: [] }, null, 2));
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'retool-gate-'));
  mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
  seedCleanTree(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Reset to the clean tree, then apply exactly one mutation (or none). */
function mutate(fn?: (dir: string) => void) {
  rmSync(path.join(root, SCAN_DIR), { recursive: true, force: true });
  seedCleanTree(root);
  fn?.(root);
}

const appendTo = (rel: string, text: string) => (dir: string) => {
  const abs = path.join(dir, SCAN_DIR, rel);
  writeFileSync(abs, `${readFileSync(abs, 'utf8')}\n${text}\n`);
};

const withDenylist = (hashes: string[]) => (dir: string) =>
  writeFileSync(path.join(dir, DENYLIST_PATH), JSON.stringify({ version: 1, hashes }, null, 2));

describe('positive control — the clean tree passes', () => {
  it('passes with no salt, and says the denylist was skipped rather than passing silently', () => {
    mutate();
    const result = runGate({ root, salt: undefined });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.notes.join(' ')).toMatch(/denylist SKIPPED/);
  });

  it('scans a non-zero number of files — a gate wired to nothing also reports zero findings', () => {
    mutate();
    // The clean fixture seeds exactly three in-scope files; the denylist lives
    // outside SCAN_DIR and must not be counted as scanned content.
    expect(runGate({ root, salt: SALT }).files.length).toBe(3);
  });

  it('fails loudly if the scan directory is empty, rather than passing on nothing', () => {
    mutate((dir) => rmSync(path.join(dir, SCAN_DIR), { recursive: true, force: true }));
    const result = runGate({ root, salt: SALT });
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/scanned nothing/);
  });
});

describe('check 2 — IPv4 range allowlist', () => {
  it.each([
    ['203.0.113.7', true, 'RFC5737 TEST-NET-3, what the redaction writes'],
    ['198.51.100.9', true, 'RFC5737 TEST-NET-2'],
    ['192.0.2.4', true, 'RFC5737 TEST-NET-1'],
    ['10.1.2.3', true, 'RFC1918'],
    ['172.16.0.1', true, 'RFC1918 lower bound'],
    ['172.31.255.254', true, 'RFC1918 upper bound'],
    ['192.168.1.1', true, 'RFC1918'],
    ['127.0.0.1', true, 'loopback'],
    [PUBLIC_DNS_IP, false, 'a real routable address'],
    ['172.32.0.1', false, 'just OUTSIDE RFC1918 — the /12 boundary, not a /16'],
    ['203.0.114.1', false, 'adjacent to TEST-NET-3 but outside it'],
    ['109.236.62.211', false, 'the shape of a real banned-user IP'],
  ])('%s allowed=%s (%s)', (ip, allowed) => {
    expect(isAllowedIPv4(ip as string)).toBe(allowed);
  });

  it('blocks a routable IP and names the IPv4 rule', () => {
    mutate(appendTo('bulk-ban.md', `banned from ${PUBLIC_DNS_IP} yesterday`));
    const result = runGate({ root, salt: SALT });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(PUBLIC_DNS_IP);
    expect(result.failures[0]).toMatch(/outside the documentation\/private ranges/);
  });

  it('does not flag a version-like string whose octets exceed 255', () => {
    expect(findOutOfRangeIPv4('build 1.2.3.999 shipped')).toEqual([]);
  });
});

describe('check 3 — credential shapes', () => {
  it.each([
    ['bearer-token', 'Authorization: Bearer sk-abcdef0123456789ghij'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
    ['postgres-dsn', 'postgres://appuser:hunter2hunter2@db.example.com:5432/prod'],
    ['stripe-key', 'sk_live_51H8xQ2abcdefghijklmnop'],
    ['secret-assignment', `const apiKey = '${FAKE_SECRET}'`],
  ])('catches %s', (rule, sample) => {
    const found = findCredentialShapes(sample);
    expect(found.map((f) => f.rule)).toContain(rule);
  });

  it('every declared rule has at least one case above — a rule with no case is untested', () => {
    const covered = new Set([
      'bearer-token',
      'jwt',
      'postgres-dsn',
      'stripe-key',
      'secret-assignment',
    ]);
    expect(CREDENTIAL_RULES.map((r) => r.name).sort()).toEqual([...covered].sort());
  });

  it.each([
    'Authorization: Bearer <REDACTED>',
    "const apiKey = '__REDACTED__'",
    "password: '<password>'",
  ])('does not flag an already-redacted value: %s', (sample) => {
    expect(findCredentialShapes(sample)).toEqual([]);
  });

  it('blocks a planted secret assignment and names the credential rule', () => {
    mutate(appendTo('bulk-ban.md', `const apiKey = '${FAKE_SECRET}'`));
    const result = runGate({ root, salt: SALT });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/\[secret-assignment\]/);
  });
});

describe('check 1 — hashed denylist', () => {
  it('normalises whitespace, so a line-wrapped value still matches', () => {
    // This is the round-3 defect from PR #4476: a wrap split the token and a
    // contiguous grep returned a confident zero.
    const digest = hashValue(SALT, DENIED_NAME);
    const wrapped = `reviewed by Ada\n  Lovelace on Tuesday`;
    expect(findDenylistHits(wrapped, { salt: SALT, hashes: [digest] })).toEqual([digest]);
  });

  it('is case-insensitive and punctuation-insensitive', () => {
    const digest = hashValue(SALT, DENIED_NAME);
    expect(findDenylistHits('"ADA, LOVELACE"', { salt: SALT, hashes: [digest] })).toEqual([digest]);
  });

  it('does not fire on an unrelated value', () => {
    const digest = hashValue(SALT, DENIED_NAME);
    expect(findDenylistHits('reviewed by Grace Hopper', { salt: SALT, hashes: [digest] })).toEqual(
      []
    );
  });

  it('a different salt produces a different digest — the salt is load-bearing', () => {
    expect(hashValue('salt-a', DENIED_NAME)).not.toEqual(hashValue('salt-b', DENIED_NAME));
  });

  it('blocks a planted denylisted value, and does NOT print it', () => {
    const digest = hashValue(SALT, DENIED_NAME);
    mutate((dir) => {
      withDenylist([digest])(dir);
      appendTo('bulk-ban.md', `escalated to ${DENIED_NAME} for review`)(dir);
    });
    const result = runGate({ root, salt: SALT });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/denylisted known-bad value/);
    // Printing the value would undo the redaction the gate exists to protect.
    expect(result.failures[0]).not.toContain(DENIED_NAME);
    expect(result.failures[0]).not.toContain('Lovelace');
  });

  it('SKIPS rather than passes when the salt is absent, even with the value present', () => {
    const digest = hashValue(SALT, DENIED_NAME);
    mutate((dir) => {
      withDenylist([digest])(dir);
      appendTo('bulk-ban.md', `escalated to ${DENIED_NAME} for review`)(dir);
    });
    const result = runGate({ root, salt: undefined });
    expect(result.denylistActive).toBe(false);
    expect(result.notes.join(' ')).toMatch(/denylist SKIPPED/);
    // The other checks still ran and still found nothing wrong in this fixture.
    expect(result.failures).toEqual([]);
  });

  it('tokenize strips punctuation and lowercases', () => {
    expect(tokenize('  Ada,   LOVELACE!\n(byron) ')).toEqual(['ada', 'lovelace', 'byron']);
  });
});

describe('check 4 — redaction placeholders survive', () => {
  it('blocks when a placeholder is replaced by a real-looking name', () => {
    mutate((dir) =>
      writeFileSync(
        path.join(dir, SCAN_DIR, 'raw', 'user-lookup-v2.json'),
        JSON.stringify({ gate: `current_user.fullName === '${DENIED_NAME}'` }, null, 2)
      )
    );
    const result = runGate({ root, salt: undefined });
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/redaction placeholder is gone/);
    expect(result.failures.join(' ')).toMatch(/__MODERATOR_A__/);
  });

  it('blocks when a whole export file disappears', () => {
    mutate((dir) => rmSync(path.join(dir, SCAN_DIR, 'raw', 'bulk-ban.json')));
    const result = runGate({ root, salt: undefined });
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/file is absent/);
  });

  it('reports every missing placeholder, not just the first', () => {
    const missing = findMissingPlaceholders(() => '');
    expect(missing.length).toBeGreaterThanOrEqual(3);
  });
});
