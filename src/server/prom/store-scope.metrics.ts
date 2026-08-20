import client from 'prom-client';
import { PROM_PREFIX } from '@civitai/telemetry/client';

/**
 * APP-STORE READ-SCOPE metrics — the detection net for civitai#3983.
 *
 * ## Why this exists
 *
 * `resolveStoreVisibilityScope` is a SILENT gate. Every wrong answer it can give
 * renders as an ordinary, successful, empty page:
 *   - `scope === 'none'` → the tRPC read procs return `{ items: [] }` and
 *     `getAppDetail` throws NOT_FOUND;
 *   - the procedures' `?? 'none'` makes an ABSENT scope indistinguishable from a
 *     genuine `none`;
 *   - and from outside, `none` and `public-external`-with-no-matching-rows are the
 *     same two bytes.
 *
 * So when the external-only tester cohort was granted the store and got an empty
 * grid, nothing anywhere reported a problem — not to the users, not to operators,
 * and not to the investigation, which spent its whole length unable to tell those
 * cases apart from the outside. The bug was live and silent.
 *
 * These counters make the gate legible.
 *
 * ## The three signals
 *
 * `civitai_app_store_scope_resolutions_total{scope, principal}` — every resolution,
 * labelled with the answer (`full|public-external|none`) and whether a session user
 * was present (`user|anon`). SIX series, fixed. This is the signal that answers
 * "what is production actually resolving for a logged-in viewer?" — the question
 * that previously required an instrumented deploy to ask.
 *
 * `civitai_app_store_scope_applied_total{scope, entrypoint}` — what each entry point
 * actually BRANCHED on, recorded before its own `??` default. Its extra `absent`
 * value is the one thing a response can never tell you: whether a scope arrived at
 * all. Read as a PAIR with the resolution counter — agreement means the answer is
 * simply wrong, disagreement means the answer is being lost in transit. Those two
 * faults need opposite fixes and were indistinguishable for the whole of #3983.
 *
 * `civitai_app_store_scope_divergence_total{flag}` — the IMPOSSIBLE COMBINATION: a
 * LOGGED-IN principal for whom the async read path resolved `none`, while a
 * same-request re-read of the very same store flag says the viewer holds it. That
 * is precisely the shape of the reported defect — a viewer the `/apps` page gate
 * admits (it keys on the sync evaluation) reaching a read path that serves them
 * nothing. `flag` is one of the three store flag keys, so the label is bounded and
 * names the axis that disagreed.
 *
 * 🔴 WHAT THE DIVERGENCE COUNTER CANNOT SEE — say it plainly rather than let a flat
 * zero read as "healthy":
 *   - a scope that is resolved CORRECTLY and then lost or ignored downstream (the
 *     ctx-plumbing / caller-default class). The resolution counter is what covers
 *     that: compare its `full|public-external` counts against what the read paths
 *     actually return.
 *   - a Flipt client that is uniformly dead. Then both evaluations agree on `false`,
 *     no divergence is recorded, and the tell is instead an all-`none` resolution
 *     mix plus the client's own `init-flipt-error` log.
 *   - an ANONYMOUS caller. There is no page-gate/read-path pairing to contradict for
 *     a principal with no session, so anon is deliberately out of scope here.
 *
 * Pinned on globalThis so an HMR re-eval / a second request-graph eval reuse the one
 * instance instead of throwing prom-client's duplicate-registration error (the same
 * trap documented for the http-error and dev-tunnel counters).
 */

declare global {
  // eslint-disable-next-line no-var
  var __civitaiStoreScopeMetrics:
    | {
        resolutions: client.Counter<string>;
        applied: client.Counter<string>;
        divergence: client.Counter<string>;
        publicCatalog: client.Counter<string>;
      }
    | undefined;
}

const metrics =
  globalThis.__civitaiStoreScopeMetrics ??
  (globalThis.__civitaiStoreScopeMetrics = {
    resolutions: new client.Counter({
      name: PROM_PREFIX + 'store_scope_resolutions_total',
      help:
        'Cumulative App-store read-scope resolutions, by resolved scope ' +
        '(full|public-external|none) and whether a session user was present (user|anon). ' +
        'Monotonic; use rate(). A logged-in population that is entirely `none` while a ' +
        'cohort flag is open is the civitai#3983 signature.',
      labelNames: ['scope', 'principal'],
    }),
    applied: new client.Counter({
      name: PROM_PREFIX + 'store_scope_applied_total',
      help:
        'Cumulative store-scope values a read ENTRY POINT actually branched on, by entrypoint. ' +
        "`scope` is `absent` when no scope reached the branch at all — the one case a caller's " +
        'own default (`?? none` on tRPC, `?? full` in the listing service) silently erases. ' +
        'Compare against store_scope_resolutions_total: a resolution mix that disagrees with ' +
        'the applied mix means the scope is being LOST between the resolver and the branch.',
      labelNames: ['scope', 'entrypoint'],
    }),
    divergence: new client.Counter({
      name: PROM_PREFIX + 'store_scope_divergence_total',
      help:
        'Cumulative IMPOSSIBLE combinations: a logged-in principal whose store read scope ' +
        'resolved `none` while a same-request re-read of the labelled store flag says they ' +
        'hold it. Any non-zero rate means the page gate and the read path disagree for a ' +
        'real viewer — alert on it.',
      labelNames: ['flag'],
    }),
    publicCatalog: new client.Counter({
      name: PROM_PREFIX + 'store_public_catalog_decisions_total',
      help:
        'Cumulative PUBLIC App-catalog grant decisions at the /api/v1/apps REST endpoints, ' +
        'by outcome and entrypoint. `granted` = the caller was LIFTED to the public catalog ' +
        'floor because their own scope was narrower than it (the intended steady state, and ' +
        'the anonymous case); `withheld` = the apps-public-catalog-disabled kill switch was ' +
        'on, so the caller kept THEIR OWN resolved scope and nothing more — that is `none` ' +
        'for an anonymous caller but NOT necessarily nothing, a cohort caller still reads ' +
        'their own scope through it; `privileged` = the caller was already at or above the ' +
        'floor and was passed through untouched, without the switch even being evaluated. ' +
        'This is the ONLY signal that says whether the public catalog is actually open — a ' +
        '`withheld` rate rising from zero is the kill switch having been thrown, ' +
        'deliberately or not.',
      labelNames: ['outcome', 'entrypoint'],
    }),
  });

export type StoreScopePrincipal = 'user' | 'anon';

/**
 * Every store surface that branches on a resolved scope.
 *
 * 🔴 No longer read-only. `trpc-review-write` / `trpc-my-review` are the review
 * WRITE procs, which moved off the `app-listings` flag onto this same scope (the
 * external-only cohort could see the review affordance and be refused on submit).
 * They are labelled distinctly from `trpc-reviews` (the public list read) on
 * purpose: a scope mix that differs between the read and the write of the same
 * surface is precisely the shape of that defect, and folding them into one label
 * would make it unobservable again.
 */
export type StoreScopeEntrypoint =
  | 'trpc-list'
  | 'trpc-detail'
  | 'trpc-reviews'
  | 'trpc-review-write'
  | 'trpc-my-review'
  | 'rest-list'
  | 'rest-detail';

/**
 * Record the scope an entry point actually branched on.
 *
 * 🔴 `undefined` is recorded as the DISTINCT value `absent`, never folded into
 * `none`. That distinction is the whole point: from outside the service,
 * "resolved `none`" and "no scope arrived, so the caller's default applied" produce
 * byte-identical responses (`{ items: [] }` on tRPC, the FULL catalog through the
 * listing service's `?? 'full'`), and telling them apart was the single thing
 * civitai#3983 could not do without an instrumented deploy.
 *
 * Never throws — telemetry must not break a read.
 */
export function recordStoreScopeApplied(
  scope: string | undefined,
  entrypoint: StoreScopeEntrypoint
): void {
  try {
    metrics.applied.inc({ scope: scope ?? 'absent', entrypoint });
  } catch {
    /* never throw from telemetry */
  }
}

/** Record one scope resolution. Never throws — telemetry must not break a read. */
export function recordStoreScopeResolution(scope: string, principal: StoreScopePrincipal): void {
  try {
    metrics.resolutions.inc({ scope, principal });
  } catch {
    /* never throw from telemetry */
  }
}

/** The three ways the public-catalog grant can answer. Bounded on purpose. */
export type PublicCatalogOutcome = 'granted' | 'withheld' | 'privileged';

/**
 * Record one public-catalog grant decision (see
 * `~/server/services/blocks/public-apps-catalog`). Never throws — telemetry must not
 * break a read.
 *
 * Read as a PAIR with `store_scope_applied_total`: that counter says what the
 * resolver produced, this one says what the public REST surface decided to do about
 * it. `applied{scope="absent"}` with `decisions{outcome="granted"}` is the known,
 * open #3983 resolver defect being absorbed by the deliberate grant — not a new
 * exposure, because `absent` and a resolved `none` take the identical branch.
 *
 * 🔴 `withheld` DOES NOT MEAN THE CALLER GOT NOTHING — read the name as "the public
 * GRANT was withheld", not "the response was empty". Since civitai#4048 the withheld
 * branch returns the caller's OWN resolved scope, so a caller in the external-only
 * cohort still reads `public-external` while the switch is on; only a caller who
 * resolved `none` of their own (every anonymous one) actually goes dark. The three
 * outcomes partition callers by what the grant DID to them — lifted them
 * (`granted`), was withdrawn from them (`withheld`), or had nothing to offer them
 * because they were already at or above the floor (`privileged`) — not by what they
 * ended up being able to read.
 */
export function recordPublicCatalogDecision(
  outcome: PublicCatalogOutcome,
  entrypoint: StoreScopeEntrypoint
): void {
  try {
    metrics.publicCatalog.inc({ outcome, entrypoint });
  } catch {
    /* never throw from telemetry */
  }
}

/** Record one page-gate/read-path divergence for `flag`. Never throws. */
export function recordStoreScopeDivergence(flag: string): void {
  try {
    metrics.divergence.inc({ flag });
  } catch {
    /* never throw from telemetry */
  }
}
