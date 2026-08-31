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
  return bracedBodies(source, /\.\s*json\(\s*\{/g);
}

/**
 * Every `new TRPCError({…})` constructor body, via the SAME scanner.
 *
 * 🔴 This exists as a one-liner on purpose. It was briefly a second, hand-rolled
 * brace matcher that counted raw `{`/`}` with no quote awareness — and a delta
 * audit broke it with a real file under `src/server`: one `}` inside a string
 * literal truncated the body, and a genuine no-cause bypass below that point went
 * invisible while the ledger stayed green. That is the EXACT bug `scanBody` was
 * made quote-aware for in #3881 (`'oops }'`), regrown two hundred lines away.
 *
 * A truncated body is worse than no body, too: it still gets inspected, so the
 * detector reports a confident "clean" on text it never read.
 *
 * One rule, one place — both extractors are now the same scan with a different
 * opening pattern.
 */
function trpcErrorBodies(source: string): string[] {
  return bracedBodies(source, /new TRPCError\(\s*\{/g);
}

/** Find each `call` site, then quote-aware brace-match its object argument. */
function bracedBodies(source: string, call: RegExp): string[] {
  const out: string[] = [];
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
 * 🔴 TIER 1 — UNAUTHENTICATED. **All five are now FIXED** (civitai#3845 follow-up)
 * and have left this list; they are asserted from the other side in
 * `FIXED_BY_THIS_CHANGE` below and behaviourally in
 * `src/tests/api/tier1-public-route-disclosure.test.ts`. The fix was NOT a
 * delegation: each answered a 4xx for EVERY failure including zod-parse
 * rejections, so routing them blindly through the helper would have turned a
 * legitimate client 400 into a 500. Each route now separates the validation
 * rejection (kept, with its detail) from the server-side failure (delegated).
 *
 * `download/models/[modelVersionId].ts` is the one that stayed on this list, and
 * it is an OVER-REPORT, not a leak — see that block.
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
  // ── OVER-REPORTS — flagged by shape, NOT leaks. Kept so the count is honest ──
  // All three build `{ error: message }` inside a local helper, so the guard sees
  // an IDENT value and flags the file. It cannot see, without types, that every
  // call site passes text WE wrote. The previous round's answer to that was a name
  // allowlist, which is what buried `download/models` for a whole round. Recorded
  // instead — and for `download/models` the "every call site" claim is not left as
  // a comment: `download-model-error-response.test.ts` asserts it structurally, so
  // re-introducing `errorResponse(500, err.message)` fails a test even though this
  // ledger would stay green (`src/tests/api/tier1-public-route-disclosure.test.ts`).
  //
  // 🔴 `download/models` was TIER 1 and IS fixed — its 500 arm no longer forwards
  // `err.message`. It could only leave this list by restructuring the response
  // helper purely to dodge a regex, which is the wrong direction; it stays here,
  // reclassified, with a real guard behind it.
  'download/attachments/[fileId].ts',
  'download/models/[modelVersionId].ts',
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

/**
 * Routes fixed for civitai#3845 — must never appear in the exception list above.
 *
 * Two groups, both asserted identically. The TIER-1 group is the follow-up: those
 * routes were enumerated as unfixed in the list above and are now closed. Adding
 * them here is the SHRINK direction of the ledger — the entry had to be deleted
 * above AND the route re-checked shape-by-shape here, so a half-fix (message
 * genericized on one arm only) cannot pass by editing one list.
 */
const FIXED_BY_THIS_CHANGE = [
  // ── civitai#3845 follow-up — the TIER-1 unauthenticated routes ──────────────
  'generation/data.ts',
  'generation/resources.ts',
  'v1/images/index.ts',
  'v1/model-files/[id]/tensor-metadata.ts',
  // ── the 11 hand-rolled envelopes consolidated in the parent change ──────────
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
   * 🔴 A KNOWN GAP, now CLOSED — and the ledger stays, at zero.
   *
   * `isDriverAuthoredMessage` matches on message identity against a driver error
   * in the `cause` chain. A site that re-wraps a caught error's `.message` into a
   * 4xx TRPCError WITHOUT setting `cause` therefore defeats it: the text on the
   * wire is the driver's, but nothing in the chain proves that. If the underlying
   * error is a Prisma or pg error, its text still reaches a 4xx body.
   *
   * There were 17 such sites, all on the App Blocks / referral tRPC surface. All
   * 17 now pass `cause`, so the expected set is EMPTY — which is precisely the
   * reading a broken detector also produces. Three things separate the two, and
   * all three run below before the empty-set assertion:
   *   1. the walk finds files at all;
   *   2. `TRPC_CTOR` extracts constructor bodies at all;
   *   3. the whole detector, run on a synthetic no-cause site, returns 1 — and on
   *      the with-cause version of the SAME site, returns 0.
   * Without (3) a regex typo reads as "gap closed". A zero is only evidence
   * alongside a positive control that made the number move.
   *
   * 🔴 The caught-name alternation `(?:e|err|error|ex)` is DELIBERATE and
   * MEASURED, not an oversight. Widening it to any identifier — the fix that was
   * right for the `.json()` body sweep above — adds four sites in
   * `routers/orchestrator.router.ts`, and all four are FALSE POSITIVES:
   * `message: status.message ?? generationStatusDefaultMessage`, where `status`
   * is the operator-configured generation status, not a caught error. `x.message`
   * is far too common a benign shape to anchor on here. The blind spot that
   * remains, stated: a catch that binds something other than those four names is
   * invisible to this ledger.
   */
  it("LEDGER: no TRPCError forwards a caught error's `.message` at a 4xx without `cause`", () => {
    const SERVER_ROOT = path.resolve(__dirname, '../..');
    // All 17 sites are fixed. An entry reappearing here means the gap re-opened.
    const KNOWN_BYPASS: [string, number][] = [];

    const fromCaught = /message:\s*\(?(?:e|err|error|ex)\)?(?:\s+as\s+\w+)?\)?\.message/;

    /**
     * A `cause` that CANNOT carry the driver error is no better than none.
     *
     * 🔴 Found by mutation: this was `!body.includes('cause')`, and changing a
     * real `cause: e` to `cause: undefined` left the ledger fully GREEN — the
     * substring was still there, the bypass fully re-opened. The same
     * spelled-vs-structural failure as the `.json()` body sweep above, in
     * miniature.
     *
     * 🔴 And the FIRST fix for it was also wrong, which is why the value is
     * EXTRACTED here rather than excluded by a lookahead. A
     * `cause\s*:\s*(?!undefined)` reads as correct and is not: `\s*` is
     * variable-length, so the engine backtracks it to zero width and tests the
     * lookahead against " undefined", which does not begin with "undefined" —
     * the negative lookahead passes and the inert cause reads as fixed again.
     * Pull the value out, trim it, compare it.
     */
    function hasUsefulCause(body: string): boolean {
      // `{ ..., cause }` shorthand — a binding, so it carries something.
      if (/(?:^|[{,])\s*cause\s*(?:[,}]|$)/.test(body)) return true;
      const m = /(?:^|[{,])\s*cause\s*:\s*([^,}]+)/.exec(body);
      if (!m) return false;
      const value = m[1].trim();
      return value !== '' && value !== 'undefined' && value !== 'null';
    }

    /** The WHOLE detector, over one source string — so a control can drive it. */
    function bypassCount(source: string): number {
      let n = 0;
      for (const body of trpcErrorBodies(stripLineComments(source))) {
        if (fromCaught.test(body) && !hasUsefulCause(body)) n++;
      }
      return n;
    }

    const files = walk(SERVER_ROOT).filter((f) => !f.includes('__tests__'));
    const found: Record<string, number> = {};
    for (const file of files) {
      const n = bypassCount(readFileSync(file, 'utf8'));
      if (n) found[path.relative(SERVER_ROOT, file).split(path.sep).join('/')] = n;
    }

    // ── Controls. All three must pass or the empty result below means nothing. ──
    expect(
      files.length,
      'the src/server walk returned nothing — the ledger is inert'
    ).toBeGreaterThan(200);
    expect(
      files.reduce((acc, f) => acc + trpcErrorBodies(readFileSync(f, 'utf8')).length, 0),
      'no `new TRPCError({…})` bodies extracted — the detector is wired to nothing'
    ).toBeGreaterThan(400);

    // 🔴 The nesting control. The regex this replaced (`[^{}]*?`) matched NEITHER
    // of these — a nested object literal and a `${}` template both contain braces
    // — so both sites were silently exempt from the ledger. Pinned by exemplar so
    // a revert to any brace-naive matcher fails here rather than going quiet.
    expect(
      bypassCount(`new TRPCError({ code: 'BAD_REQUEST', message: err.message, meta: { id: 1 } })`),
      'a nested object literal must not hide a bypass'
    ).toBe(1);
    expect(
      bypassCount('new TRPCError({ code: `BAD_${x}`, message: err.message })'),
      'a template literal must not hide a bypass'
    ).toBe(1);
    // 🔴 The delta-audit probe. A `}` INSIDE a string truncated the body under the
    // hand-rolled brace matcher this replaced, so any bypass after it was invisible
    // while the ledger reported clean — and a truncated body is worse than none,
    // because it still gets inspected. This is the same shape `scanBody` was made
    // quote-aware for in #3881; the exemplar lives here so the fix cannot rot back.
    expect(
      bypassCount(`new TRPCError({ code: 'BAD_REQUEST', note: 'oops }', message: err.message })`),
      'a `}` inside a string must not truncate the body'
    ).toBe(1);

    // 🔴 The one that makes a ZERO mean something: the number must MOVE.
    const bypassSample = `throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });`;
    const fixedSample = `throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message, cause: err });`;
    expect(bypassCount(bypassSample), 'the detector cannot see a no-cause site at all').toBe(1);
    expect(bypassCount(fixedSample), 'the detector cannot see that `cause` fixes it').toBe(0);
    // …and with the OTHER binding the fix uses. `apps-shared.router.ts` binds `e`,
    // and a mechanical sweep on the `err` spelling got that site wrong.
    expect(bypassCount(`new TRPCError({ code: 'BAD_REQUEST', message: e.message })`)).toBe(1);
    expect(
      bypassCount(`new TRPCError({ code: 'BAD_REQUEST', message: e.message, cause: e })`)
    ).toBe(0);
    // 🔴 And an INERT `cause` must NOT count as fixed — the mutant that survived
    // the first version of this ledger.
    expect(
      bypassCount(`new TRPCError({ code: 'BAD_REQUEST', message: e.message, cause: undefined })`),
      '`cause: undefined` carries no driver error — it must not read as fixed'
    ).toBe(1);
    expect(
      bypassCount(`new TRPCError({ code: 'BAD_REQUEST', message: e.message, cause: null })`)
    ).toBe(1);

    expect(
      Object.entries(found).sort(),
      "a TRPCError site forwards a caught error's `.message` at a 4xx WITHOUT `cause`. That " +
        're-opens the civitai#3845/3 leak at that site, because `isDriverAuthoredMessage` ' +
        'cannot see a driver error that is not in the cause chain, so a genuine ' +
        '`Invalid `prisma.…` invocation` reaches the client verbatim at a 4xx. Fix: pass ' +
        '`cause: <the caught binding>` alongside the message — and CHECK THE BINDING NAME, ' +
        'which is `e` in apps-shared.router.ts and `err` everywhere else.'
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
