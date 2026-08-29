import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_RULES,
  DENYLIST_PATH,
  MAX_NGRAM_WORDS,
  REPO_ROOT,
  REQUIRED_PLACEHOLDERS,
  SCAN_DIR,
  SENTINEL_VALUE,
  findCredentialShapes,
  findDenylistHits,
  findIPv6,
  findMissingPlaceholders,
  findOutOfRangeIPv4,
  annotate,
  passScope,
  hashValue,
  isAllowedIPv4,
  mask,
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

/**
 * A minimal but STRUCTURALLY REAL export tree.
 *
 * 🔴 The placeholder COUNTS here must equal `REQUIRED_PLACEHOLDERS`, because check 4
 * now asserts counts rather than presence. Building the fixture from the ledger
 * itself would make the test vacuous — it would agree with any ledger, including a
 * wrong one — so the counts are written out literally and a separate test asserts
 * the ledger matches the REAL exports.
 */
function seedCleanTree(dir: string) {
  const raw = path.join(dir, SCAN_DIR, 'raw');
  mkdirSync(raw, { recursive: true });
  writeFileSync(
    path.join(raw, 'user-lookup-v2.json'),
    JSON.stringify(
      {
        a1: "current_user.fullName === '__MODERATOR_A__'",
        a2: '__MODERATOR_A__',
        b1: '__MODERATOR_B__',
        b2: '__MODERATOR_B__',
        c1: '__MODERATOR_C__',
        c2: '__MODERATOR_C__',
      },
      null,
      2
    )
  );
  const banBody =
    'WHERE ip IN (203.0.113.1, 203.0.113.2, 203.0.113.3, 203.0.113.4) ' +
    'AND toAccountId IN (<accountId>, <accountId>, <accountId>, <accountId>, <accountId>)';
  writeFileSync(path.join(raw, 'bulk-ban.json'), JSON.stringify({ sql: banBody }, null, 2));
  writeFileSync(path.join(dir, SCAN_DIR, 'bulk-ban.md'), `| query |\n| ${banBody} |\n`);
  writeFileSync(
    path.join(dir, DENYLIST_PATH),
    JSON.stringify({ version: 1, sentinel: null, hashes: [] }, null, 2)
  );
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
    expect(result.failures[0]).not.toContain(PUBLIC_DNS_IP); // masked — r2 F2
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
      'secret-assignment-template',
      'retool-kv-credential',
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

// ===========================================================================
// Regressions from the round-1 adversarial audit of #4486.
// Each of these pins a defect that was EXECUTED against the gate, not imagined.
// ===========================================================================

describe('audit 🔴1 — the placeholder ledger must be as wide as its claim', () => {
  /**
   * 🔴 This is the test that stops the ledger silently narrowing again. It reads the
   * REAL exports, not a fixture: a fixture built from the ledger agrees with any
   * ledger, including the 3-of-10 one that shipped and passed everything.
   */
  it('every ledger entry matches the real exports at the count it declares', () => {
    for (const { file, token, count } of REQUIRED_PLACEHOLDERS) {
      const abs = path.join(REPO_ROOT, SCAN_DIR, file);
      const text = readFileSync(abs, 'utf8');
      expect(`${file}:${token}=${text.split(token).length - 1}`).toBe(`${file}:${token}=${count}`);
    }
  });

  it('guards all three documented classes, not just the moderator-A token', () => {
    const tokens = new Set(REQUIRED_PLACEHOLDERS.map((p) => p.token));
    // #4476 documents three personal-data classes; `<accountId>` is the only one
    // with NO other check behind it — a bare integer has no shape.
    expect(tokens).toContain('__MODERATOR_A__');
    expect(tokens).toContain('__MODERATOR_B__');
    expect(tokens).toContain('__MODERATOR_C__');
    expect(tokens).toContain('<accountId>');
    expect(tokens).toContain('203.0.113.');
  });

  it("the audit's executed scenario now FAILS: 2 staff names + 5 account ids restored", () => {
    mutate((dir) => {
      const ul = path.join(dir, SCAN_DIR, 'raw', 'user-lookup-v2.json');
      writeFileSync(
        ul,
        readFileSync(ul, 'utf8')
          .replace(/__MODERATOR_B__/g, 'Grace Hopper')
          .replace(/__MODERATOR_C__/g, 'Alan Turing')
      );
      for (const rel of [['raw', 'bulk-ban.json'], ['bulk-ban.md']]) {
        const abs = path.join(dir, SCAN_DIR, ...rel);
        writeFileSync(abs, readFileSync(abs, 'utf8').replace(/<accountId>/g, '8675309'));
      }
    });
    const result = runGate({ root, salt: undefined });
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(4);
  });

  it('catches a PARTIAL re-introduction — presence alone would read as clean', () => {
    mutate((dir) => {
      const ul = path.join(dir, SCAN_DIR, 'raw', 'user-lookup-v2.json');
      // One of two occurrences reverted: the token is still present.
      writeFileSync(ul, readFileSync(ul, 'utf8').replace('__MODERATOR_B__', 'Grace Hopper'));
    });
    const result = runGate({ root, salt: undefined });
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/expected 2 occurrence\(s\).*found 1/);
  });
});

describe('audit 🔴2 — a salt/hash desync must fail, never pass silently', () => {
  const seedActive = (saltForHashes: string) => (dir: string) =>
    writeFileSync(
      path.join(dir, DENYLIST_PATH),
      JSON.stringify(
        {
          version: 1,
          sentinel: hashValue(saltForHashes, SENTINEL_VALUE),
          hashes: [hashValue(saltForHashes, DENIED_NAME)],
        },
        null,
        2
      )
    );

  const plantName = (dir: string) => {
    const ul = path.join(dir, SCAN_DIR, 'raw', 'user-lookup-v2.json');
    writeFileSync(ul, readFileSync(ul, 'utf8').replace('__MODERATOR_B__', DENIED_NAME));
  };

  it('positive control — the CORRECT salt finds the planted value', () => {
    mutate((dir) => {
      seedActive(SALT)(dir);
      plantName(dir);
    });
    const result = runGate({ root, salt: SALT });
    expect(result.denylistActive).toBe(true);
    expect(result.failures.join(' ')).toMatch(/denylisted known-bad value/);
  });

  it('a ROTATED salt fails loudly instead of matching nothing and passing', () => {
    mutate((dir) => {
      seedActive(SALT)(dir);
      plantName(dir);
    });
    const result = runGate({ root, salt: 'a-different-salt' });
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/does not match the one these hashes/);
    expect(result.denylistActive).toBe(false);
  });

  it('a trailing newline in the CI secret is trimmed, not silently fatal', () => {
    mutate((dir) => {
      seedActive(SALT)(dir);
      plantName(dir);
    });
    const result = runGate({ root, salt: `${SALT}\n` });
    expect(result.failures.join(' ')).toMatch(/denylisted known-bad value/);
  });

  it('hashes with NO sentinel run but say they are unverified', () => {
    mutate((dir) =>
      writeFileSync(
        path.join(dir, DENYLIST_PATH),
        JSON.stringify({ version: 1, hashes: [hashValue(SALT, DENIED_NAME)] }, null, 2)
      )
    );
    const result = runGate({ root, salt: SALT });
    expect(result.notes.join(' ')).toMatch(/ACTIVE but UNVERIFIED/);
  });
});

describe('audit 🟡5 — the credential rule must cover the corpus it scans', () => {
  it.each([
    ['quoted JSON key', '"apiKey": "AKIAQQQ12345678ZZ"'],
    ['screaming-snake JSON key', '"WEBHOOK_TOKEN": "ghp_abcdefghij0123456789"'],
    ['escaped double-quoted JS in JSON', '\\"const apiKey = \\"AKIAQQQ12345678ZZ\\"\\"'],
    ['template literal', 'const apiKey = `AKIAQQQ12345678ZZ`'],
    ['lowercase bearer', 'authorization: bearer ghp_abcdefghij0123456789'],
    ['uppercase BEARER', 'AUTHORIZATION: BEARER ghp_abcdefghij0123456789'],
  ])('catches %s', (_label, sample) => {
    expect(findCredentialShapes(sample).length).toBeGreaterThan(0);
  });

  it('does not run away across a large JSON blob (the 646KB over-match)', () => {
    // The first widened regex included backticks in the quote class, so one opener
    // consumed the rest of the file and reported a 646,934-char "secret".
    const blob = `{"token":"${'a'.repeat(400)}","other":${JSON.stringify('x'.repeat(50_000))}}`;
    for (const hit of findCredentialShapes(blob)) {
      const chars = Number(/^(\d+) chars/.exec(hit.sample)?.[1] ?? 0);
      expect(chars).toBeLessThanOrEqual(4096);
    }
  });
});

describe('audit 🟡6 — findings must not republish the value', () => {
  it('masks a credential value rather than printing it', () => {
    const found = findCredentialShapes("const apiKey = 'AKIAQQQ12345678ZZ'");
    expect(found).toHaveLength(1);
    expect(found[0].sample).not.toContain('AKIAQQQ12345678ZZ');
    expect(found[0].sample).toMatch(/^\d+ chars, sha256:[0-9a-f]{8}…$/);
  });

  it('mask leaks neither the value nor a usable prefix of it', () => {
    expect(mask('109.236.62.211')).not.toContain('109.236');
  });
});

describe('audit 🟡7 — --hash refuses what the matcher cannot find', () => {
  it(`throws above ${MAX_NGRAM_WORDS} word tokens`, () => {
    expect(() => hashValue(SALT, 'Maria Anna Sophia Von Habsburg')).toThrow(/could never match/);
  });

  it('accepts exactly MAX_NGRAM_WORDS, and that digest really does match', () => {
    const digest = hashValue(SALT, 'Anna Sophia Von Habsburg');
    expect(
      findDenylistHits('signed off by Anna Sophia Von Habsburg today', {
        salt: SALT,
        hashes: [digest],
      })
    ).toEqual([digest]);
  });

  it('throws on a value with no word tokens', () => {
    expect(() => hashValue(SALT, '!!! ---')).toThrow(/no word tokens/);
  });
});

describe('audit nits — IPv6 and dotted-quad adjacency', () => {
  it('flags a real IPv6 address', () => {
    expect(findIPv6('client 2a01:4f8:c17:1234::1 banned')).toEqual(['2a01:4f8:c17:1234::1']);
  });

  // NOT "the allowlist exempts them" — V6_RE requires a leading `group:`, so bare
  // ::/::1 never match at all. The old version of this test asserted the same
  // empty array and passed with the allowlist DELETED: vacuous either way.
  it('does not match bare ::/::1, which the pattern structurally cannot emit', () => {
    expect(findIPv6('bound ::1 and ::')).toEqual([]);
  });

  it('does not flag ordinary colon-separated text', () => {
    expect(findIPv6('12:30:45 duration, key:value')).toEqual([]);
  });

  it('does not flag a dotted quad inside a longer version string', () => {
    expect(findOutOfRangeIPv4('version 1.2.3.4.5.6 shipped')).toEqual([]);
    expect(findOutOfRangeIPv4('build 10.20.30.40.1')).toEqual([]);
  });

  it('still flags a standalone routable address', () => {
    expect(findOutOfRangeIPv4('from 109.236.62.211 today')).toEqual(['109.236.62.211']);
  });
});

describe('real-corpus regressions the synthetic cases did not catch', () => {
  it('an EMPTY secret-named value does not run across into the next JSON key', () => {
    // Found by running the widened rule against the real exports: the workflow
    // files carry `\"databasePasswordOverride\",\"\",\"functionParameters\"` — the
    // override is EMPTY, which is the safe state, but a value body that allowed
    // `\"` swallowed the empty string and reported a 21-char "secret".
    const sample = String.raw`,\"databasePasswordOverride\",\"\",\"functionParameters\"`;
    expect(findCredentialShapes(sample)).toEqual([]);
  });

  it('the real exports pass — the corpus IS the false-positive control', () => {
    const result = runGate({ root: REPO_ROOT, salt: undefined });
    expect(result.failures).toEqual([]);
    expect(result.files.length).toBeGreaterThan(20);
  });
});

// ===========================================================================
// Round-2 delta audit regressions. Every one of these is a case the round-1
// FIX introduced — each regex was widened on one axis and narrowed on another.
// ===========================================================================

describe('audit r2 🟡F3 — the V4 lookahead must not eat a sentence period', () => {
  it.each([
    'Banned the account at 8.8.8.8.',
    'The user last logged in from 8.8.8.8. Ban applied.',
    'from 8.8.8.8...',
    'at 8.8.8.8, then elsewhere',
    '(8.8.8.8)',
  ])('still finds a routable IP in prose: %s', (sample) => {
    expect(findOutOfRangeIPv4(sample)).toEqual([PUBLIC_DNS_IP]);
  });

  it.each(['version 1.2.3.4.5', 'build 10.20.30.40.1', 'v2.45.13.22.9'])(
    'still ignores a dotted quad inside a longer run: %s',
    (sample) => {
      expect(findOutOfRangeIPv4(sample)).toEqual([]);
    }
  );
});

describe('audit r2 🟡F4 — IPv6 must catch the one-group-before-:: family', () => {
  it.each([
    'fe80::1',
    'fe80::a00:27ff:fe4e:66a1',
    '2a02::1',
    'fd00::abcd',
    '2001::dead:beef',
    '2001:db8::1',
  ])('flags %s', (addr) => {
    expect(findIPv6(`client ${addr} banned`)).toEqual([addr]);
  });

  it('still ignores ordinary colon-separated text', () => {
    expect(findIPv6('12:30:45 duration, key:value, ratio 3:1')).toEqual([]);
  });
});

describe('audit r2 🟡F5 — long opaque secrets must not fall off the top', () => {
  it.each([201, 320, 512, 1024])('catches a %s-char opaque token', (len) => {
    const found = findCredentialShapes(`{"token": "${'a'.repeat(len)}"}`);
    expect(found.map((f) => f.rule)).toContain('secret-assignment');
  });

  it('still cannot run away across a large blob', () => {
    const blob = `{"token":"${'a'.repeat(400)}","other":${JSON.stringify('x'.repeat(50_000))}}`;
    for (const hit of findCredentialShapes(blob)) {
      expect(Number(/^(\d+) chars/.exec(hit.sample)?.[1] ?? 0)).toBeLessThanOrEqual(4096);
    }
  });
});

describe('audit r2 🟡F6 — the prefix widener must not flag author*/tokenizer', () => {
  it.each([
    '{"author": "Jane Quinn Public"}',
    '{"authorName": "Jane Q Public"}',
    '{"authorEmail": "jane@example.com"}',
    '"authorAvatarUrl": "https://x.example/a.png"',
    '{"authorized": "yes-by-moderator"}',
    '{"tokenizer": "whitespace-basic"}',
    '{"tags": ["auth","authentication"]}',
  ])('does not flag %s', (sample) => {
    expect(findCredentialShapes(sample)).toEqual([]);
  });

  it.each([
    '"WEBHOOK_TOKEN": "ghp_abcdefghij0123456789"',
    '{"apiKey": "abcdef123456"}',
    "const stripeSecretKey = 'sk_live_abcdefghijkl'",
  ])('still flags the real shape %s', (sample) => {
    expect(findCredentialShapes(sample).length).toBeGreaterThan(0);
  });
});

describe('audit r2 \u{1F7E1}F7 — annotations point at the file that regressed', () => {
  it('derives file= from the finding, not the hardcoded denylist path', () => {
    const msg = `${SCAN_DIR}/raw/user-lookup-v2.json: redaction placeholder is gone`;
    const out = annotate('error', msg, true);
    expect(out).toBe(`::error file=${SCAN_DIR}/raw/user-lookup-v2.json::${msg}`);
    expect(out).not.toContain(DENYLIST_PATH);
  });

  it('falls back to the denylist path only when the message names no file', () => {
    expect(annotate('warning', 'something with no path prefix', true)).toContain(
      `file=${DENYLIST_PATH}`
    );
  });

  it('outside Actions it is plain text, not an annotation', () => {
    expect(annotate('error', 'x.json: boom', false)).toBe(
      'retool-sanitiser-gate: ERROR x.json: boom'
    );
  });
});

describe('audit r2 🔴F2 — no branch may print a raw value', () => {
  it('masks the IPv4 address, the class this gate exists to keep out', () => {
    mutate(appendTo('bulk-ban.md', 'banned from 109.236.62.211 yesterday'));
    const result = runGate({ root, salt: undefined });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).not.toContain('109.236.62.211');
    expect(result.failures[0]).not.toContain('109.236');
    expect(result.failures[0]).toMatch(/\d+ chars, sha256:[0-9a-f]{8}…/);
  });

  it('masks the IPv6 address too', () => {
    mutate(appendTo('bulk-ban.md', 'client 2a01:4f8:c17:1234::1 banned'));
    const result = runGate({ root, salt: undefined });
    expect(result.failures.join(' ')).not.toContain('2a01:4f8');
  });
});

describe('audit r2 \u{1F7E2}F11 — guards the fix round left unguarded', () => {
  it('the value floor is the quantifier, pinned at its boundary', () => {
    // A separate minValueLength property was removed as unreachable: the
    // quantifier counts repetitions and each unescapes to >=1 char, so no input
    // could ever reach the floor. This pins the real behaviour instead.
    expect(findCredentialShapes('{"token": "abcdefg"}')).toEqual([]); // 7
    expect(findCredentialShapes('{"token": "abcdefgh"}').length).toBe(1); // 8
  });

  it('the PASS scope string SHRINKS when the denylist did not run', () => {
    expect(passScope(true)).toContain('no known-bad value');
    expect(passScope(false)).not.toContain('no known-bad value');
    expect(passScope(false)).toContain('THE DENYLIST DID NOT RUN');
  });
});

// ===========================================================================
// Round-3 delta audit. Two of these restore tests an earlier scripted edit of
// mine DELETED (it replaced from a marker to end-of-file); the audit caught the
// loss by noticing no test named the defect the commit claimed to have pinned.
// ===========================================================================

describe('audit r3 — IPv6 must not fire on a Postgres cast (restored)', () => {
  it.each([
    'SELECT id::date FROM bans',
    'SELECT userId::text, createdAt::timestamptz FROM t',
    'WHERE amount::decimal > 0',
    'SELECT payload::jsonb, ref::uuid, ok::boolean FROM t',
    'SELECT count(*)::int FROM bans',
  ])('does not flag %s', (sql) => {
    expect(findIPv6(sql)).toEqual([]);
  });
});

describe('audit r3 — the comma separator stays reverted (restored)', () => {
  it('does NOT catch the transit "KEY","value" pair, by measured decision', () => {
    expect(findCredentialShapes('"WEBHOOK_TOKEN","ghp_abcdefghij0123456789"')).toEqual([]);
  });
});

describe('audit r3 🟡1 — IPv6 at the end of a sentence', () => {
  it.each([
    ['client 2a01:4f8:c17:1234::1.', '2a01:4f8:c17:1234::1'],
    ['Banned the account at fe80::1.', 'fe80::1'],
    ['Banned fe80::a00:27ff:fe4e:66a1. Ban applied.', 'fe80::a00:27ff:fe4e:66a1'],
    ['from 2001:db8::1...', '2001:db8::1'],
    ['ip:2001:db8::1', '2001:db8::1'],
    ['(2001:db8::1)', '2001:db8::1'],
  ])('finds the address in %s', (text, addr) => {
    expect(findIPv6(text)).toEqual([addr]);
  });
});

describe('audit r3 🟡2 — no single-group IPv6 exemption; ALLOWED_V6 is live', () => {
  it.each(['fe80::', '::dead', '::beef'])('flags the single-group address %s', (addr) => {
    expect(findIPv6(`host ${addr} down`)).toEqual([addr]);
  });

  it('still exempts loopback and unspecified — and now really via ALLOWED_V6', () => {
    expect(findIPv6('bound ::1 and :: today')).toEqual([]);
  });
});

describe('audit r3 🟡3 — dropping the i flag must not lose real identifiers', () => {
  it.each([
    '{"Authorization": "Basic ZGVtbzpwYXNzd29yZDEyMw=="}',
    '{"authorization": "Basic ZGVtbzpwYXNzd29yZDEyMw=="}',
    // INVARIANT GUARD, not a regression test: the pre-existing `AUTH` branch
    // already caught this (uppercase `O` passes the anchor), so it was green
    // before the widening too and cannot fail for it.
    '{"AUTHORIZATION": "Basic ZGVtbzpwYXNzd29yZDEyMw=="}',
    '{"authentication": "Basic ZGVtbzpwYXNzd29yZDEyMw=="}',
    '{"X-API-Key": "abcdef1234567890"}',
    '{"X-API-KEY": "abcdef1234567890"}', // invariant guard, as above
    '{"Api_key": "abcdef1234567890"}',
    '{"Apikey": "abcdef1234567890"}',
    '{"tokens": "abcdef1234567890"}',
    '{"secrets": "abcdef1234567890"}',
    '{"passwords": "abcdef1234567890"}',
    '{"secretkey": "abcdef1234567890"}',
  ])('catches %s', (sample) => {
    // These pin the `{"Authorization": "..."}` JSON-key shape only. The corpus's
    // OWN 12 Authorization entries use Retool's transit pair instead, which no
    // assignment rule can see — that is covered by `retool-kv-credential` and its
    // own describe block below. An earlier version of this comment claimed these
    // cases covered the corpus, which was false and would have stopped the next
    // person looking.
    expect(findCredentialShapes(sample).length).toBeGreaterThan(0);
  });

  it.each([
    '{"author": "Jane Quinn Public"}',
    '{"authorName": "Jane Q Public"}',
    '{"authorEmail": "jane@example.com"}',
    '{"authorized": "yes-by-moderator"}',
    '{"tokenizer": "whitespace-basic"}',
  ])('still does not flag %s', (sample) => {
    expect(findCredentialShapes(sample)).toEqual([]);
  });
});

// ===========================================================================
// Round-4 delta audit.
// ===========================================================================

describe('audit r4 🟡F1 — no lookahead may suppress IPv4-embedded IPv6', () => {
  it.each([
    '::ffff:8.8.8.8',
    '::ffff:192.168.1.1',
    '2001:db8::1.2.3.4',
    'banned 64:ff9b::104.16.132.229 today',
  ])('reports something for %s', (sample) => {
    // `::ffff:192.168.1.1` previously matched NOTHING — not check 2 either, since
    // the inner address is RFC1918. The reported literal may truncate at the
    // embedded IPv4; that is cosmetic, because findings are masked anyway.
    expect(findIPv6(sample).length).toBeGreaterThan(0);
  });

  it('still finds an address at the end of a sentence', () => {
    expect(findIPv6('Banned the account from fe80::1.')).toEqual(['fe80::1']);
    expect(findIPv6('from 2001:db8::1...')).toEqual(['2001:db8::1']);
  });
});

describe("audit r4/r5 — the corpus's OWN Authorization serialisation", () => {
  // All 12 Authorization entries in raw/user-lookup-v2.json are Retool transit
  // pairs: \"key\":\"Authorization\",\"value\":\"Basic …\". The identifier is a
  // VALUE and the separator is `,`, so neither assignment rule can see it.
  //
  // 🔴 ESCAPING DEPTH IS PARAMETERISED, and that is the whole point. The first
  // version of these tests hardcoded ONE backslash. The corpus uses THREE (181 of
  // 191 `key` occurrences; the rest use one, none use zero) because Retool nests
  // JSON inside JSON inside a string. So the rule was inert on the only file it
  // was written for, and this spec passed anyway — the fixture and the code
  // encoded the same wrong assumption, and neither could see the other's error.
  const ESCAPES = ['', '\\', '\\\\\\'];
  const kv = (key: string, value: string, e: string) =>
    `${e}"key${e}"${e}:${e}"${key}${e}"${e},${e}"value${e}"${e}:${e}"${value}${e}"`
      .replace(new RegExp(`${e ? e.replace(/\\/g, '\\\\') : '(?!)'}:`, 'g'), ':')
      .replace(new RegExp(`${e ? e.replace(/\\/g, '\\\\') : '(?!)'},`, 'g'), ',');

  describe.each(ESCAPES.map((e) => [e.length, e] as const))('at escaping depth %i', (_depth, e) => {
    it('catches a live Basic credential', () => {
      const found = findCredentialShapes(
        kv('Authorization', 'Basic ZGVtbzpzdXBlcnNlY3JldDEyMw==', e)
      );
      expect(found.map((f) => f.rule)).toContain('retool-kv-credential');
    });

    it.each(['X-API-Key', 'token', 'WEBHOOK_TOKEN', 'password'])(
      'catches credential-named key %s',
      (key) => {
        expect(findCredentialShapes(kv(key, 'abcdef1234567890', e)).length).toBeGreaterThan(0);
      }
    );

    it('does NOT fire on the redacted placeholder the corpus actually holds', () => {
      expect(
        findCredentialShapes(kv('Authorization', 'Basic {{ FreshdeskCredentials.value }}', e))
      ).toEqual([]);
    });

    it.each(['author', 'authorName', 'authorEmail', 'authorized', 'tokenizer'])(
      'does NOT fire on the non-credential key %s',
      (key) => {
        // The kv key needs the same end-of-identifier anchor the assignment
        // rules carry; without it this whole class came back.
        expect(findCredentialShapes(kv(key, 'Jane Q Public xyz', e))).toEqual([]);
      }
    );
  });

  it('does NOT fire on an ordinary array — why the bare comma rule was reverted', () => {
    expect(findCredentialShapes('{"tags": ["auth","authentication"]}')).toEqual([]);
    expect(findCredentialShapes('{"columns": ["password","created_at_utc"]}')).toEqual([]);
  });

  it('does not fire when the key is not credential-named', () => {
    expect(findCredentialShapes(kv('Content-Type', 'application/json-x', '\\'))).toEqual([]);
  });

  // 🔴 THE CONTROL THAT WOULD HAVE CAUGHT THE INERT RULE: drive the REAL file,
  // not a fixture whose shape I chose. A fake can encode the same mistake as the
  // code; the corpus cannot.
  describe('driven by the real export, not a fixture', () => {
    const REAL = path.join(REPO_ROOT, SCAN_DIR, 'raw/user-lookup-v2.json');
    const REDACTED_VALUE = 'Basic {{ FreshdeskCredentials.value }}';

    it('the real file is clean', () => {
      const text = readFileSync(REAL, 'utf8');
      expect(text).toContain(REDACTED_VALUE); // the substitution below is anchored on this
      expect(findCredentialShapes(text).filter((f) => f.rule === 'retool-kv-credential')).toEqual(
        []
      );
    });

    it('a live credential substituted into it IS caught', () => {
      const text = readFileSync(REAL, 'utf8');
      const live = text.replace(REDACTED_VALUE, 'Basic ZGVtbzpzdXBlcnNlY3JldDEyMw==');
      expect(live).not.toEqual(text); // positive control: the substitution happened
      const found = findCredentialShapes(live).filter((f) => f.rule === 'retool-kv-credential');
      expect(found.length).toBeGreaterThan(0);
      expect(found[0].sample).not.toContain('ZGVtbz'); // still masked
    });
  });
});

describe('audit r6 🟡F1 — secret-assignment must reach the corpus escaping depth too', () => {
  // `Q` was widened to 0-3 backslashes, but this rule hardcoded `\\?` for the
  // VALUE quote, so it stayed capped at depth 1 while its own comment claimed to
  // cover "the dominant serialisation" — which is depth 3. Latent (no corpus
  // instance today) but the comment was wider than the code, which is the exact
  // defect this whole gate exists to prevent.
  it.each([
    [0, ''],
    [1, '\\'],
    [2, '\\\\'],
    [3, '\\\\\\'],
  ])('catches a quoted secret assignment at escaping depth %i', (_d, e) => {
    const sample = `{"a":1, ${e}"apiKey${e}": ${e}"abcdefghij1234${e}"}`;
    expect(findCredentialShapes(sample).map((f) => f.rule)).toContain('secret-assignment');
  });

  it('still ignores an already-redacted value at depth 3', () => {
    const e = '\\\\\\';
    expect(findCredentialShapes(`{${e}"apiKey${e}": ${e}"<REDACTED>${e}"}`)).toEqual([]);
  });
});
