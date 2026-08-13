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
 * Extract the text of every object literal passed to a `.json(...)` call.
 *
 * 🔴 This replaced three regexes that were **spelled guards, not structural ones**.
 * An audit defeated all three at once by simply dropping the literal
 * `'An unexpected error occurred'`: a file containing only
 * `return res.status(500).json({ error });` — the exact whole-object leak the
 * ledger exists to stop — swept CLEAN. Two narrower holes died with them:
 * `res.status(getHTTPStatusCodeFromError(e))` could not match a `[^)]*` status
 * group, and `res.json({ error })` with no `.status()` was never considered.
 *
 * So: find the CALL, brace-match its argument, and inspect the object's KEYS AND
 * VALUE SHAPES — which is what the hazard actually is. These cannot be spelled
 * around, because they name what the value IS rather than what sits next to it.
 */
function jsonBodies(source: string): string[] {
  const out: string[] = [];
  const call = /\.\s*json\(\s*\{/g;
  for (let m = call.exec(source); m; m = call.exec(source)) {
    const start = source.indexOf('{', m.index);
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) {
          out.push(source.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

/** An identifier a `catch (…)` binding realistically uses. */
const CAUGHT = String.raw`(?:e|err|error|ex)`;

/**
 * The value shapes that put a whole error object — or its driver-authored text —
 * on the wire. A string-literal value (`{ error: 'Forbidden' }`) is deliberately
 * NOT matched: the hazard is serializing an Error, not using the key.
 */
const LEAKING_BODY_SHAPES: { name: string; re: RegExp }[] = [
  {
    name: '`error` bound to a caught error object (its enumerable own props serialize)',
    // `{ error }` shorthand, `{ error: err }`, `{ error: e as Error }`.
    re: new RegExp(
      String.raw`(?:^|[{,])\s*error\s*(?:\}|,|:\s*\(?${CAUGHT}\)?(?:\s+as\s+\w+)?\s*[,}\)])`
    ),
  },
  {
    name: '`cause` in a response body (the wrapped driver error, under a second key)',
    re: /(?:^|[{,])\s*cause\s*(?:\}|,|:)/,
  },
  {
    name: '`error: <expr>.cause` (serves the error the TRPCError wrapped)',
    re: new RegExp(String.raw`(?:^|[{,])\s*error\s*:\s*[A-Za-z_$][\w$]*\.cause\b`),
  },
  {
    name: "`error`/`message` set to a caught error's `.message` (verbatim driver text)",
    re: new RegExp(
      String.raw`(?:^|[{,])\s*(?:error|message)\s*:\s*\(?${CAUGHT}\)?(?:\s+as\s+\w+)?\)?\.message\b`
    ),
  },
];

/**
 * 🔴 Sites of the SAME class this change does not fix — enumerated, not glossed.
 *
 * Making the guard structural surfaced this: the class was never confined to the
 * 11 routes civitai#3845 enumerated. Every entry is recorded rather than
 * exempted-by-glob, so the list fails if it GROWS (a new site) or SHRINKS (one
 * was fixed — delete its line). Ordered by exposure, which is the order to fix in:
 *
 * 🔴 TIER 1 — UNAUTHENTICATED. Same severity as the routes this change fixes.
 *   generation/{data,resources}.ts        PublicEndpoint; catch-all → 400 + e.message
 *   v1/model-files/[id]/tensor-metadata   MixedAuthEndpoint (public read) → 422 + err.message
 * NOT fixed here because the fix is not a delegation: each answers 4xx for EVERY
 * failure including zod-parse rejections, so routing them through the helper turns
 * a legitimate client 400 into a 500. That needs its own red/green and review.
 *
 * 🟡 TIER 2 — session-authed: a logged-in user can trigger it, the public cannot.
 * 🟢 TIER 3 — operator surfaces behind JOB_TOKEN / WEBHOOK_TOKEN / moderator auth
 * (`WebhookEndpoint`, `ModEndpoint`, `OrchestratorEndpoint`). There the driver
 * detail is arguably the POINT — admin/backfill/debug tools whose caller is us.
 * Listed for completeness; fixing them is optional and may be undesirable.
 */
const KNOWN_UNFIXED_SAME_CLASS: string[] = [
  // TIER 1 — unauthenticated
  'generation/data.ts',
  'generation/resources.ts',
  'v1/model-files/[id]/tensor-metadata.ts',
  // TIER 2 — session-authed
  'blocks/submit-version.ts',
  'download/user-transactions.ts',
  'image/ingest.ts',
  'media/ingest/[mediaId].ts',
  'upload/abort.ts',
  'upload/complete.ts',
  'upload/sign-part.ts',
  'v1/blocks/models.ts',
  'v1/blocks/submit-version.ts',
  'v1/blocks/withdraw.ts',
  'v1/image-upload/multipart/index.ts',
  // TIER 3 — operator / token-gated
  'admin/temp/backfill-b2-file-locations.ts',
  'admin/temp/dedupe-official-files.ts',
  'admin/temp/migrate-article-images.ts',
  'admin/temp/migrate-model-flags.ts',
  'admin/temp/remove-deprecated-base-models.ts',
  'admin/test.ts',
  'admin/update-freshdesk-customer.ts',
  'mod/clavata-image-process.ts',
  'mod/csam-upload.ts',
  'mod/mute-user-pending-review.ts',
  'mod/overturn-user-mute.ts',
  'mod/queue-model-metric-update.ts',
  'mod/reconcile-nowpayments.ts',
  'mod/reprocess-buzz-purchases.ts',
  'mod/reprocess-order.ts',
  'mod/scanner-policies/export-dataset.ts',
  'mod/unblock-images.ts',
  'mod/withdraw-from-bank.ts',
  'orchestrator/refreshBlobs.ts',
  'testing/blue-buzz-paid-access.ts',
  'testing/model-file-scan.ts',
  'testing/redis-cluster.ts',
  'testing/xguard-test.ts',
  'webhooks/resource-training.ts',
  'webhooks/run-jobs/[[...run]].ts',
  'webhooks/scanner-policy-result.ts',
  'webhooks/text-moderation-result.ts',
];

/** Routes this change fixed — must never appear in the exception list above. */
const FIXED_BY_THIS_CHANGE = [
  'notification/getDetails.ts',
  'run/[modelVersionId].ts',
  'v1/content/[[...slug]].ts',
  'v1/creators.ts',
  'v1/permissions/check.ts',
  'v1/tags.ts',
  'v1/users/index.ts',
  'v1/vault/all.tsx',
  'v1/vault/check-vault.tsx',
  'v1/vault/get.tsx',
  'v1/vault/toggle-version.tsx',
];

describe('LEDGER: no REST route serializes an error object or its text (civitai#3845/4)', () => {
  const files = walk(API_ROOT);

  it('finds the API tree (positive control — an empty sweep must not read as clean)', () => {
    // 🔴 A zero from a file walk is indistinguishable from a walk wired to
    // nothing. Prove the instrument can see before believing what it reports.
    expect(files.length, 'the src/pages/api walk returned nothing — the guard is inert').
      toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(path.join('v1', 'creators.ts')))).toBe(true);
  });

  it('extracts json bodies at all (positive control on the extractor itself)', () => {
    // The sweep is `bodies.some(...)`. If `jsonBodies` returned [] for every file,
    // every shape would report zero offenders and the ledger would be a very
    // convincing no-op.
    const bodies = files.flatMap((f) => jsonBodies(stripLineComments(readFileSync(f, 'utf8'))));
    expect(bodies.length, 'no `.json({…})` bodies extracted — the extractor is inert').
      toBeGreaterThan(100);
    expect(
      jsonBodies(`res.status(500).json({ error: 'x', nested: { a: 1 } });`),
      'brace matching must survive a nested object'
    ).toEqual([`{ error: 'x', nested: { a: 1 } }`]);
  });

  it('the offender set is EXACTLY the recorded baseline — a new one fails here', () => {
    const offenders = files
      .filter((f) =>
        jsonBodies(stripLineComments(readFileSync(f, 'utf8'))).some((b) =>
          LEAKING_BODY_SHAPES.some((s) => s.re.test(b))
        )
      )
      .map((f) => path.relative(API_ROOT, f).split(path.sep).join('/'))
      .sort();

    expect(
      offenders,
      'a REST route now serializes an error object (or its text) into a response body. ' +
        'Route it through `handleEndpointError` instead — a whole error object serializes its ' +
        'enumerable own props, which for a Prisma error is the table + column and for a pg ' +
        '23505 is the offending ROW VALUE. If you FIXED a baseline entry, delete its line ' +
        'from KNOWN_UNFIXED_SAME_CLASS.'
    ).toEqual([...KNOWN_UNFIXED_SAME_CLASS].sort());
  });

  it('none of the routes THIS change fixed are in the offender set', () => {
    // A list of exceptions can swallow the very thing it was written around.
    // Assert the 11 explicitly, both ways.
    for (const rel of FIXED_BY_THIS_CHANGE) {
      expect(
        KNOWN_UNFIXED_SAME_CLASS,
        `${rel} is in the exception list — it is supposed to be FIXED`
      ).not.toContain(rel);
      const bodies = jsonBodies(
        stripLineComments(readFileSync(path.join(API_ROOT, rel), 'utf8'))
      );
      for (const shape of LEAKING_BODY_SHAPES) {
        expect(bodies.some((b) => shape.re.test(b)), `${rel} still matches "${shape.name}"`).toBe(
          false
        );
      }
    }
  });

  it('every shape CAN match, incl. the probe that defeated the previous patterns', () => {
    // Negative control per shape. The FIRST sample is the one an audit used to
    // walk through the old ledger untouched: no generic message literal, no
    // `cause`, no `.status()` chain to anchor on.
    const mustMatch: [string, number][] = [
      [`return res.json({ error });`, 0],
      [`res.status(500).json({ message: 'An unexpected error occurred', error });`, 0],
      [`res.status(getHTTPStatusCodeFromError(e)).json({ ok: false, error: err });`, 0],
      [`res.status(500).json({ error: 'Invalid database operation', cause: error });`, 1],
      [`return res.status(500).json({ error: error.cause });`, 2],
      [`res.status(500).json({ message: 'x', error: err.message });`, 3],
      [`res.status(422).json({ error: (err as Error).message });`, 3],
    ];
    for (const [sample, shapeIndex] of mustMatch) {
      const body = jsonBodies(sample)[0];
      expect(body, `extractor failed on: ${sample}`).toBeDefined();
      expect(
        LEAKING_BODY_SHAPES[shapeIndex].re.test(body),
        `shape "${LEAKING_BODY_SHAPES[shapeIndex].name}" failed on its own exemplar: ${sample}`
      ).toBe(true);
    }
  });

  it('does NOT match a hand-written string body (guards against an over-broad sweep)', () => {
    // The counterpart control: a guard that matches EVERYTHING is as useless as
    // one that matches nothing, and would force the next author to work around it.
    const mustNotMatch = [
      `res.status(403).json({ error: 'Forbidden' });`,
      `res.status(404).json({ error: message });`,
      `res.status(400).json({ error: z.prettifyError(result.error) ?? 'Invalid file id' });`,
      `res.status(400).json({ error: parsed.error.flatten() });`,
      `res.status(200).json({ items, metadata });`,
    ];
    for (const sample of mustNotMatch) {
      const body = jsonBodies(sample)[0];
      for (const shape of LEAKING_BODY_SHAPES) {
        expect(shape.re.test(body), `"${shape.name}" false-positives on: ${sample}`).toBe(false);
      }
    }
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
