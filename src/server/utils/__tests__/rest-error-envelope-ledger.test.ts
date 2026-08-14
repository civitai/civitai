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
    const body = scanBody(source, start, true);
    // An UNTERMINATED quote (an apostrophe in a trailing `//` comment, a regex
    // literal containing one) would otherwise consume to end-of-file and emit
    // NOTHING for this call — silence, which is the worse failure direction.
    // Fall back to a quote-blind scan rather than dropping the body.
    const fallback = body ?? scanBody(source, start, false);
    if (fallback) out.push(fallback);
  }
  return out;
}

/**
 * Brace-match from `start`, returning ONLY the depth-1 slice — the body's
 * top-level keys, with nested object literals elided.
 *
 * 🔴 Two bugs merged into one pass, because as two passes the second undid the
 * first. Round 2 made `jsonBodies` quote-aware to stop a `}` inside `'oops }'`
 * truncating the body — then handed its output to a *separate*, quote-BLIND
 * `topLevelKeys()` which truncated it again at exactly the same character. An
 * audit measured the end-to-end result as unchanged, and both mutants that
 * deleted the quote-handling left the suite green: the fix was inert, while its
 * JSDoc claimed the hazard was closed. One pass now does both.
 *
 * Nesting is elided because the shapes anchor on `[{,]` and would otherwise match
 * a key at ANY depth — `json({ items, summary: { error, warnings } })` and
 * `json({ incident: { cause: 'flood' } })` were both flagged as leaks. A guard
 * that matches everything just trains the next author to edit the baseline.
 *
 * Consequence, stated: an error nested one level down
 * (`{ data: { detail: err.message } }`) is NOT detected.
 */
function scanBody(source: string, start: number, quoteAware: boolean): string | null {
  let out = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quoteAware && quote) {
      if (ch === '\\') i++;
      else if (ch === quote) {
        quote = null;
        // Emit the closing quote so a string value survives as an EMPTY literal
        // (`'x'` -> `''`). It must remain visibly a string: the shapes match an
        // IDENT, so `{ error: '' }` correctly does not look like `{ error: err }`.
        if (depth === 1) out += ch;
      }
      continue;
    }
    if (quoteAware && (ch === "'" || ch === '"' || ch === '`')) {
      quote = ch;
      if (depth === 1) out += ch;
      continue;
    }
    if (ch === '{') {
      depth++;
      if (depth === 1) out += ch;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) return out + ch;
      continue;
    }
    if (depth === 1) out += ch;
  }
  return null;
}

/**
 * Any identifier, not a fixed spelling.
 *
 * 🔴 A delta audit defeated the previous version — `(?:e|err|error|ex)` — with a
 * REAL, live, unauthenticated leak: `v1/images/index.ts` binds its caught error
 * to `trpcError` and serves `{ error: trpcError.message, code: trpcError.code }`
 * from a `PublicEndpoint`. Anchoring on the variable NAME was the same species of
 * spelled guard as the literal-message regex it replaced, just a smaller hole.
 *
 * 🔴 **The round-2 fix then re-added the same species on the VALUE side.** A
 * `NOT_AN_ERROR` allowlist (`message`, `reason`, `detail`, …) exempted any body
 * whose error value was bound to a "string-ish" name. That laundered
 * `download/models/[modelVersionId].ts:257` — `errorResponse(500, err.message)` →
 * `res.json({ error: message })` on a **`PublicEndpoint`**, i.e. an
 * unauthenticated `err.message` 500 of exactly the #3845 shape — out of the
 * offender set entirely. The allowlist is GONE.
 *
 * The cost is over-reporting: a body that genuinely serves a string we wrote
 * (`{ error: message }` where `message` is a literal) is now flagged. That is the
 * right direction to be wrong in. Those land in the baseline once, annotated,
 * instead of a name heuristic silently deciding which disclosures count.
 */
const IDENT = String.raw`[A-Za-z_$][\w$]*`;

/**
 * The value shapes that put a whole error object — or its driver-authored text —
 * on the wire. A string-literal value (`{ error: 'Forbidden' }`) is deliberately
 * NOT matched: the hazard is serializing an Error, not using the key.
 */
const LEAKING_BODY_SHAPES: { name: string; test: (body: string) => boolean }[] = [
  {
    name: '`error` bound to a caught error object (its enumerable own props serialize)',
    // `{ error }` shorthand, `{ error: err }`, `{ error: e as Error }`.
    test: (b) =>
      new RegExp(
        String.raw`(?:^|[{,])\s*error\s*(?:\}|,|:\s*\(?${IDENT}\)?(?:\s+as\s+\w+)?\s*[,}\)])`
      ).test(b),
  },
  {
    name: '`cause` in a response body (the wrapped driver error, under a second key)',
    test: (b) => /(?:^|[{,])\s*cause\s*(?:\}|,|:)/.test(b),
  },
  {
    name: '`error: <expr>.cause` (serves the error the TRPCError wrapped)',
    test: (b) => new RegExp(String.raw`(?:^|[{,])\s*error\s*:\s*${IDENT}\.cause\b`).test(b),
  },
  {
    name: "`error`/`message` set to a caught error's `.message` (verbatim driver text)",
    // Any identifier, `?.` allowed, optional cast/parens. This is the shape the
    // widened IDENT exists for — `{ error: trpcError.message }` on a public route.
    test: (b) =>
      new RegExp(
        String.raw`(?:^|[{,])\s*(?:error|message)\s*:\s*\(?${IDENT}\)?(?:\s+as\s+[\w.<>\[\]]+)?\)?\??\.message\b`
      ).test(b),
  },
];

/** Does this response body serve an error object or its text? */
function bodyLeaks(body: string): boolean {
  return LEAKING_BODY_SHAPES.some((s) => s.test(body));
}

/**
 * 🔴 Sites of the SAME class this change does not fix — enumerated, not glossed.
 *
 * This list has been re-derived THREE times, growing each time the guard got
 * less spelled: 3 regexes → 41 → 52 → **57**. That trajectory is the finding.
 * Every widening was forced by an audit defeating the previous version with a
 * REAL shape — `v1/images/index.ts` (invisible because the binding was named
 * `trpcError`), then `download/models/[modelVersionId].ts` (invisible because a
 * name allowlist exempted the value `message`). Both are `PublicEndpoint`,
 * i.e. unauthenticated, and both are pre-existing rather than introduced here.
 * Two rounds of 'now it is structural' were each still spelled. Assume a fourth
 * shape exists.
 *
 * 🔴 **KNOWN BLIND SPOTS — this list is a floor, not a ceiling.** The extractor
 * cannot see: a body built in a variable and passed as `res.json(body)`; an error
 * nested below the top level (`{ data: { detail: err.message } }`); `String(e)` /
 * `e.toString()` / `{ ...error }`; `res.send({ error })`. Do not read a green run
 * as "no leaks exist" — read it as "no leak of a shape this guard knows".
 *
 * Every entry is recorded rather than exempted-by-glob, so the list fails if it
 * GROWS (a new site) or SHRINKS (one was fixed — delete its line). Ordered by
 * exposure, which is the order to fix in:
 *
 * 🔴 TIER 1 — UNAUTHENTICATED. Same severity as the routes this change fixes.
 *   v1/images/index.ts                    PublicEndpoint; `{ error: trpcError.message }`
 *   download/models/[modelVersionId].ts   PublicEndpoint; `errorResponse(500, err.message)`
 *   generation/{data,resources}.ts        PublicEndpoint; catch-all → 400 + e.message
 *   v1/model-files/[id]/tensor-metadata   MixedAuthEndpoint (public read) → 422 + err.message
 * NOT fixed here because the fix is not a delegation: each answers 4xx for EVERY
 * failure including zod-parse rejections, so routing them through the helper turns
 * a legitimate client 400 into a 500. That needs its own red/green and review.
 * `v1/images/index.ts` is pre-existing and unrelated to this change's diff.
 *
 * 🟡 TIER 2 — session-authed: a logged-in user can trigger it, the public cannot.
 * `blocks/submit-version.ts` is `ModEndpoint` and so belongs in TIER 3, where it
 * now is. Its `v1/` namesake is NOT — see the note on that entry.
 * TIER 2 includes `orchestrator/refreshBlobs.ts`: `OrchestratorEndpoint` is
 * `AuthedEndpoint` + a per-user token (`endpoint-helpers.ts`), with NO moderator
 * check — an earlier draft filed it under TIER 3, which would have dispositioned a
 * session-authed disclosure as "arguably the point". It is not.
 * The `v1/blocks/*` entries are `withAxiom` + block-scope auth.
 *
 * 🟢 TIER 3 — operator surfaces behind JOB_TOKEN / WEBHOOK_TOKEN / moderator auth
 * (`WebhookEndpoint`, `ModEndpoint` ONLY). There the driver detail is arguably the
 * POINT — admin/backfill/debug tools whose caller is us. Listed for completeness;
 * fixing them is optional and may be undesirable.
 */
const KNOWN_UNFIXED_SAME_CLASS: string[] = [
  // ── TIER 1 — UNAUTHENTICATED ────────────────────────────────────────────────
  'download/models/[modelVersionId].ts', // PublicEndpoint; errorResponse(500, err.message)
  'generation/data.ts',
  'generation/resources.ts',
  'v1/images/index.ts', // PublicEndpoint; { error: trpcError.message }
  'v1/model-files/[id]/tensor-metadata.ts',
  // ── OVER-REPORTS — flagged by shape, NOT leaks. Kept so the count is honest ──
  // Both build `{ error: message }` from a local helper whose every call site
  // passes a STRING LITERAL ('File not found', 'Not Found'). The guard cannot
  // see that without types; the previous round's answer was a name allowlist,
  // which is what buried `download/models` above. Recorded instead.
  'download/attachments/[fileId].ts',
  'download/vault/[vaultItemId].ts',
  // ── TIER 2 — session-authed ─────────────────────────────────────────────────
  'download/user-transactions.ts',
  'image/ingest.ts',
  'media/ingest/[mediaId].ts',
  'orchestrator/refreshBlobs.ts', // OrchestratorEndpoint = AuthedEndpoint + token, NO mod check
  'upload/abort.ts',
  'upload/complete.ts',
  'upload/sign-part.ts',
  'v1/blocks/collections/[id]/follow.ts',
  'v1/blocks/images.ts',
  'v1/blocks/models.ts',
  'v1/blocks/shared-storage/increment.ts',
  'v1/blocks/shared-storage/top.ts',
  // NOT ModEndpoint — `withAxiom` + `Authorization: Bearer <API key>`, gated by
  // `isAppBlocksAuthorEnabled`, a Flipt flag whose own docs say it grants
  // authoring to a curated cohort INDEPENDENT of the mod-only flag. An earlier
  // round filed it under TIER 3 as "ModEndpoint", which is exactly the
  // misclassification corrected for `orchestrator/refreshBlobs.ts` — signing off
  // a non-operator-reachable disclosure as "arguably the point". Mod-only in
  // practice today only because of the static mod floor.
  'v1/blocks/submit-version.ts',
  'v1/blocks/withdraw.ts',
  'v1/creator-program/join.ts',
  'v1/image-upload/multipart/index.ts',
  'v1/model-versions/early-access.ts',
  // ── TIER 3 — operator / token-gated (WebhookEndpoint or ModEndpoint) ────────
  'admin/temp/backfill-b2-file-locations.ts',
  'admin/temp/backfill-metric-agg.ts',
  'admin/temp/backfill-user-downloads.ts',
  'admin/temp/clamp-publishedat-bumps.ts',
  'admin/temp/dedupe-official-files.ts',
  'admin/temp/migrate-article-images.ts',
  'admin/temp/migrate-model-flags.ts',
  'admin/temp/remove-deprecated-base-models.ts',
  'admin/test.ts',
  'admin/update-freshdesk-customer.ts',
  'blocks/submit-version.ts', // ModEndpoint
  'mod/clavata-image-process.ts',
  'mod/csam-upload.ts',
  'mod/mute-user-pending-review.ts',
  'mod/overturn-user-mute.ts',
  'mod/queue-model-metric-update.ts',
  'mod/reconcile-nowpayments.ts',
  'mod/reprocess-buzz-purchases.ts',
  'mod/reprocess-order.ts',
  'mod/resource-training-v2.ts',
  'mod/scanner-policies/export-dataset.ts',
  'mod/unblock-images.ts',
  'mod/withdraw-from-bank.ts',
  'testing/blocks.ts',
  'testing/blue-buzz-paid-access.ts',
  'testing/model-file-scan.ts',
  'testing/redis-cluster.ts',
  'testing/xguard-test.ts',
  'webhooks/resource-training-v2/[modelVersionId].ts',
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
    expect(
      files.length,
      'the src/pages/api walk returned nothing — the guard is inert'
    ).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(path.join('v1', 'creators.ts')))).toBe(true);
  });

  it('extracts json bodies at all (positive control on the extractor itself)', () => {
    // The sweep is `bodies.some(...)`. If `jsonBodies` returned [] for every file,
    // every shape would report zero offenders and the ledger would be a very
    // convincing no-op.
    const bodies = files.flatMap((f) => jsonBodies(stripLineComments(readFileSync(f, 'utf8'))));
    expect(
      bodies.length,
      'no `.json({…})` bodies extracted — the extractor is inert'
    ).toBeGreaterThan(100);
    // The extractor returns the DEPTH-1 SLICE with nested literals elided and
    // string contents blanked — both deliberate (see `scanBody`). Pinned by value
    // so a change to either behaviour is visible here rather than only as a
    // mysterious shift in the offender count.
    expect(
      jsonBodies(`res.status(500).json({ error: 'x', nested: { a: 1 } });`),
      'nested literals elided, string contents blanked, braces balanced'
    ).toEqual([`{ error: '', nested:  }`]);
  });

  it('the extractor handles the branches no real file exercises today', () => {
    // 🔴 Both branches below are UNREACHABLE across all ~970 `.json({…})` sites in
    // the tree (measured: 0 fallbacks, 0 escape-skips), and deleting either left
    // the ledger fully green. A dead branch with no exemplar is exactly the shape
    // these rounds keep finding, so they get one here rather than a claim in a
    // comment.

    // Unterminated quote — an apostrophe in a TRAILING `//` comment survives
    // `stripLineComments`, which only drops whole-line comments. Without the
    // fallback the scan runs to EOF and emits NOTHING for this call: silence,
    // which is the worse failure direction because it reads as "clean".
    const unterminated = `res.status(500).json({ error: err.message, ok: false // don't care\n});`;
    const bodies = jsonBodies(unterminated);
    expect(bodies.length, 'the fallback must still yield a body').toBe(1);
    expect(bodies.some(bodyLeaks), 'and the leak in it must still be seen').toBe(true);

    // Escaped quote at depth 1. 🔴 The exemplar needs a `}` INSIDE the string or
    // it does not discriminate: without the escape skip the scan just runs to EOF
    // and the fallback above rescues it, so the leak is still found and the mutant
    // survives (measured — it did). With a brace in there, dropping the escape
    // skip ends the body EARLY at a real depth-0 `}`, the scan "succeeds" so the
    // fallback never fires, and `error: err.message` lands outside the extracted
    // body — a silent false negative.
    const escaped = String.raw`res.status(500).json({ note: 'it\'s } fine', error: err.message });`;
    expect(jsonBodies(escaped).some(bodyLeaks), 'an escaped quote must not blind the scan').toBe(
      true
    );
  });

  it('the offender set is EXACTLY the recorded baseline — a new one fails here', () => {
    const offenders = files
      .filter((f) => jsonBodies(stripLineComments(readFileSync(f, 'utf8'))).some(bodyLeaks))
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
      const bodies = jsonBodies(stripLineComments(readFileSync(path.join(API_ROOT, rel), 'utf8')));
      for (const shape of LEAKING_BODY_SHAPES) {
        expect(
          bodies.some((b) => shape.test(b)),
          `${rel} still matches "${shape.name}"`
        ).toBe(false);
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
      // 🔴 The delta-audit probes. Each of these walked through the previous
      // version untouched, and one of them is a LIVE unauthenticated route.
      [`res.status(500).json({ error: trpcError.message, code: trpcError.code });`, 3],
      [`res.status(500).json({ error: (reason as Error).message });`, 3],
      [`res.status(500).json({ error: err?.message ?? 'failed' });`, 3],
    ];
    for (const [sample, shapeIndex] of mustMatch) {
      const body = jsonBodies(sample)[0];
      expect(body, `extractor failed on: ${sample}`).toBeDefined();
      expect(
        LEAKING_BODY_SHAPES[shapeIndex].test(body),
        `shape "${LEAKING_BODY_SHAPES[shapeIndex].name}" failed on its own exemplar: ${sample}`
      ).toBe(true);
    }
  });

  it('does NOT match a hand-written string body (guards against an over-broad sweep)', () => {
    // The counterpart control: a guard that matches EVERYTHING is as useless as
    // one that matches nothing, and would force the next author to work around it.
    const mustNotMatch = [
      `res.status(403).json({ error: 'Forbidden' });`,
      `res.status(400).json({ error: z.prettifyError(result.error) ?? 'Invalid file id' });`,
      `res.status(400).json({ error: parsed.error.flatten() });`,
      `res.status(200).json({ items, metadata });`,
      // 🔴 Delta-audit false positives: a key at a NESTED depth is not a leak of
      // the top-level envelope, and flagging it would make the ledger
      // permanently red for the wrong reason.
      `res.status(200).json({ items, summary: { error, warnings } });`,
      `res.status(200).json({ incident: { cause: 'flood' } });`,
    ];
    for (const sample of mustNotMatch) {
      const body = jsonBodies(sample)[0];
      for (const shape of LEAKING_BODY_SHAPES) {
        expect(shape.test(body), `"${shape.name}" false-positives on: ${sample}`).toBe(false);
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
    expect(
      reachable4xx.length,
      'the derivation found no 4xx — the ledger would be vacuous'
    ).toBeGreaterThan(0);
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
      "the set of TRPCError sites that forward a caught error's `.message` at a 4xx WITHOUT " +
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
