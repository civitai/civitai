import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { prismaErrorToTrpcCode } from '~/server/utils/errorHandling';
import { GENERIC_CLIENT_ERROR_BY_STATUS } from '~/server/utils/rest-error-envelope';

/**
 * Two LEDGERS, both structural, both failing when their set GROWS **or** SHRINKS.
 *
 * The behavioural coverage for civitai#3845 lives in
 * `endpoint-helpers-driver-4xx.test.ts` (the helper) and
 * `src/tests/api/rest-envelope-consolidation.test.ts` (the 11 routes). Those pin
 * that the sites we KNOW about behave. Neither can see a TWELFTH copy written
 * next week, and neither can see a new Prisma→4xx mapping that outruns the
 * genericization map. That is what these two guards are for.
 *
 * 🔴 PR #3850 explicitly predicted the regrowth: "Leaving them patched-in-place
 * would keep the pattern alive to regrow." A ledger is the deterministic answer to
 * that; a code-review convention is not.
 */

// ── Ledger 1: no hand-rolled error envelope anywhere under src/pages/api ──────

const API_ROOT = path.resolve(__dirname, '../../../pages/api');

/**
 * Drop whole-line `//` comments before matching.
 *
 * Found the hard way: `download/attachments/[fileId].ts` carries a commented-out
 * `return res.status(500).json({ error: 'Invalid database operation', cause: error })`
 * — dead code, byte-identical to the live `run/[modelVersionId]` leak this PR
 * fixes. Reported as an offender, it is a false positive; the live body there is
 * already generic. Only whole-line comments are stripped, so a `//` inside a
 * string literal (`'https://…'`) cannot silently blind the sweep.
 */
function stripLineComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The four shapes population B actually used, as source-level patterns. Each one
 * is a real leak that shipped, NOT a stylistic preference:
 *
 *   `{ message: 'An unexpected error occurred', error }`  — whole object
 *   `{ error: err.message }` next to that message         — verbatim driver text
 *   `res.status(…).json({ error: <expr>.cause })`         — the WRAPPED driver error
 *   `res.status(…).json({ …, cause: error })`             — object under a 2nd key
 *
 * Matched on the GENERIC_SERVER_ERROR_MESSAGE literal and on `cause` appearing in
 * a response body, because those are the tells that survive reformatting. A site
 * that needs a bespoke body should build it with `restErrorBody`, which cannot
 * carry an error object.
 */
const HAND_ROLLED_PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: "the '{ message: <generic>, error }' envelope (population B's shape)",
    re: /['"]An unexpected error occurred['"]\s*,\s*\n?\s*error\b/,
  },
  {
    name: 'a response body carrying `cause:` (serializes the wrapped driver error)',
    re: /res\s*\.\s*status\([^)]*\)\s*\.\s*json\(\s*\{[^}]*\bcause\s*:/s,
  },
  {
    name: 'a response body carrying `error: <expr>.cause` (the wrapped driver error)',
    re: /res\s*\.\s*status\([^)]*\)\s*\.\s*json\(\s*\{\s*error\s*:\s*[A-Za-z_$][\w$]*\.cause\b/,
  },
];

describe('LEDGER: no REST route hand-rolls the error envelope (civitai#3845/4)', () => {
  const files = walk(API_ROOT);

  it('finds the API tree (positive control — an empty sweep must not read as clean)', () => {
    // 🔴 A zero from a file walk is indistinguishable from a walk wired to
    // nothing. Prove the instrument can see before believing what it reports.
    expect(files.length, 'the src/pages/api walk returned nothing — the guard is inert').
      toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(path.join('v1', 'creators.ts')))).toBe(true);
  });

  it.each(HAND_ROLLED_PATTERNS)('no file matches $name', ({ re }) => {
    const offenders = files.filter((f) => re.test(stripLineComments(readFileSync(f, 'utf8'))));
    expect(
      offenders.map((f) => path.relative(API_ROOT, f)).sort(),
      'route these through `handleEndpointError` instead of re-creating the envelope — ' +
        'a whole error object serializes its enumerable own props, which for a Prisma error ' +
        'is the table + column and for a pg 23505 is the offending ROW VALUE'
    ).toEqual([]);
  });

  it('the patterns CAN match (negative control — a guard that never fires is not a guard)', () => {
    // Each pattern is fed a synthetic offender built from the shape it exists to
    // catch. Without this, all three could be typos matching nothing and the sweep
    // above would report a reassuring, meaningless zero.
    const samples = [
      `res.status(500).json({ message: 'An unexpected error occurred', error });`,
      `res.status(500).json({ error: 'Invalid database operation', cause: error });`,
      `return res.status(500).json({ error: error.cause });`,
    ];
    HAND_ROLLED_PATTERNS.forEach((p, i) => {
      expect(p.re.test(samples[i]), `pattern "${p.name}" failed to match its own exemplar`).toBe(
        true
      );
    });
  });
});

// ── Ledger 2: the 4xx genericization map covers every reachable 4xx ───────────

describe('LEDGER: GENERIC_CLIENT_ERROR_BY_STATUS covers every 4xx a driver can reach', () => {
  /**
   * Derived from `prismaErrorToTrpcCode` itself rather than hand-copied, so adding
   * `P2031: 'FORBIDDEN'` upstream turns THIS red instead of silently reopening the
   * leak at 403 — `handleEndpointError` leaves a status with no entry alone.
   */
  const reachable4xx = [
    ...new Set(
      Object.values(prismaErrorToTrpcCode)
        .map((code) => getHTTPStatusCodeFromError(new TRPCError({ code })))
        .filter((status) => status >= 400 && status < 500)
    ),
  ].sort((a, b) => a - b);

  it('derives a non-empty reachable set (positive control)', () => {
    expect(reachable4xx.length, 'the derivation found no 4xx — the ledger would be vacuous').
      toBeGreaterThan(0);
  });

  it('the map keys EQUAL the reachable set — fails if either side grows or shrinks', () => {
    const mapped = Object.keys(GENERIC_CLIENT_ERROR_BY_STATUS)
      .map(Number)
      .sort((a, b) => a - b);
    expect(
      mapped,
      'a Prisma code now maps to a 4xx with no generic replacement — `handleEndpointError` ' +
        'leaves unmapped statuses ALONE, so that status would serve raw driver text. ' +
        'Add an entry to GENERIC_CLIENT_ERROR_BY_STATUS (and a case to ' +
        'endpoint-helpers-driver-4xx.test.ts).'
    ).toEqual(reachable4xx);
  });

  /**
   * 🔴 A KNOWN, BOUNDED GAP — recorded so it cannot grow silently.
   *
   * `isDriverAuthoredMessage` matches on message identity against a driver error
   * in the `cause` chain. A site that re-wraps a caught error's `.message` into a
   * 4xx TRPCError WITHOUT setting `cause` therefore defeats it: the text on the
   * wire is the driver's, but nothing in the chain proves that. If the underlying
   * error is a Prisma or pg error, its text still reaches a 4xx body.
   *
   * There are 17 such sites today, all on the App Blocks / referral tRPC surface.
   * They are NOT fixed here: the one-word fix (`cause: err`) touches four router
   * files on a different surface, with its own review and test considerations,
   * and a mechanical sweep over them is exactly the sort of edit that should not
   * ride along inside a security fix. Tracked as follow-up.
   *
   * This test pins the CURRENT set. It fails if a fifth file joins (the gap is
   * spreading — fix it there) and equally if the counts drop (someone fixed some;
   * update the ledger and delete the entry when it reaches zero). Either way the
   * gap stays visible instead of decaying into folklore.
   */
  it('LEDGER: the known `no-cause` bypass sites are exactly these — grow or shrink and this fails', () => {
    const SERVER_ROOT = path.resolve(__dirname, '../..');
    const KNOWN_BYPASS: [string, number][] = [
      ['routers/app-listings.router.ts', 2],
      ['routers/apps-shared.router.ts', 1],
      ['routers/blocks.router.ts', 13],
      ['routers/referral.router.ts', 1],
    ];

    const ctor = /new TRPCError\(\{(?<body>[^{}]*?)\}\)/gs;
    const fromCaught = /message:\s*\(?(?:e|err|error|ex)\)?(?:\s+as\s+\w+)?\)?\.message/;

    const found: Record<string, number> = {};
    for (const file of walk(SERVER_ROOT)) {
      if (file.includes('__tests__')) continue;
      const source = stripLineComments(readFileSync(file, 'utf8'));
      let n = 0;
      for (const m of source.matchAll(ctor)) {
        const body = m.groups?.body ?? '';
        if (fromCaught.test(body) && !body.includes('cause')) n++;
      }
      if (n) found[path.relative(SERVER_ROOT, file).split(path.sep).join('/')] = n;
    }

    // Positive control: the detector must be able to see a site at all, or the
    // "exactly these" assertion below is satisfied by a regex that matches nothing.
    expect(
      fromCaught.test(`code: 'BAD_REQUEST', message: (err as Error).message`),
      'the bypass detector cannot match its own exemplar — this ledger would be vacuous'
    ).toBe(true);

    expect(
      Object.entries(found).sort(),
      'the set of TRPCError sites that forward a caught error\'s `.message` at a 4xx WITHOUT ' +
        '`cause` has changed. Adding one re-opens the civitai#3845/3 leak at that site, because ' +
        '`isDriverAuthoredMessage` cannot see a driver error that is not in the cause chain. ' +
        'Fix: pass `cause: err` alongside the message.'
    ).toEqual(KNOWN_BYPASS.sort());
  });

  it('every entry discloses nothing beyond what the status already says', () => {
    for (const [status, { message }] of Object.entries(GENERIC_CLIENT_ERROR_BY_STATUS)) {
      expect(typeof message, `${status} message must be a string for the CLI decoder`).toBe(
        'string'
      );
      for (const tell of ['prisma', 'invocation', 'column', 'constraint', 'Key (', 'SELECT']) {
        expect(
          message.toLowerCase(),
          `${status}'s replacement text must not itself name internals`
        ).not.toContain(tell.toLowerCase());
      }
    }
  });
});
