import type { SessionUser } from '~/types/session';
import { logToAxiom } from '~/server/logging/client';
import { isConfirmedNonApprovedAppBlockId } from '~/server/services/blocks/known-app-blocks.service';

/**
 * THE ONE DECISION POINT: is this host mount a PRIVATE RUN, and therefore invisible to
 * the app's owner in analytics?
 *
 * ── WHAT IT IS FOR ────────────────────────────────────────────────────────────
 * `blockRenders` is the owner-facing IMPRESSION rail (read by
 * `blocks/app-views.service.ts`). A private run of a delisted app MOUNTS THE HOST, so
 * it reaches BLOCK_READY and emits a row like any other view — putting the reviewer in
 * the owner's `views.count` and, because uniques are computed per `userId`, in
 * `views.uniqueViewers` as an identifiable viewer on the day review happened. The
 * operator decision for that feature is that such a run is invisible to the owner
 * INCLUDING IN ANALYTICS. This predicate is what delivers that half; the canonical note
 * at the read site records why and what the alternative was.
 *
 * ── 🔴 THE SIGNAL IS DERIVED, NEVER SUPPLIED ──────────────────────────────────
 * Both writers are reachable by a caller who chooses the request body:
 * `/api/track/block-render` is a `PublicEndpoint`, and `track.blockRender` is a
 * `publicProcedure` a bearer/API-key client can call. So a `privateRun` field on the
 * beacon would be a gift: ANY viewer could suppress their own impressions, hiding real
 * traffic from an owner or corrupting every owner's numbers at will — strictly worse
 * than the leak being closed. Nothing here reads the request body except `appBlockId`,
 * which the writers already take from it and which cannot be used to suppress anything
 * on its own: suppression additionally requires that THIS SESSION independently
 * resolves to a private-run audience for THAT app. The two inputs are the session and
 * the database; the payload cannot reach either.
 *
 * ── 🔴 WHY IT CANNOT OVER-FILTER A REAL VIEWER ────────────────────────────────
 * Over-filtering is the quieter and worse failure — it deletes the owner's real numbers
 * and nobody reports numbers they never saw. Two independent facts bound it:
 *
 *   (a) `resolvePrivateRunAccess` REFUSES an approved app (`reason: 'approved'`; the
 *       non-approved resolver's mirror-image branch). So an approved — i.e. publicly
 *       mountable — app can never be suppressed, whatever the viewer's role.
 *   (b) It requires the viewer to be the OWNER, an ACCEPTED collaborator, or a
 *       MODERATOR of that app. An unrelated viewer resolves to `no-role`.
 *
 * Together: a suppressed impression is always (non-approved app) × (a viewer with a
 * named relationship to it or a moderator). A third party's impression is unreachable
 * from here. The cheap discriminator below is a COST filter only — it can make this
 * function return `false` (record the row), never `true`.
 *
 * ── 🔴 WHY IT CALLS THE REAL PREDICATE INSTEAD OF A CHEAPER LOOKALIKE ─────────
 * A hand-rolled "owner of a non-approved app" test would be a THIRD gate on this
 * surface, and an SSR↔MINT asymmetry is the one defect the shared predicate exists to
 * prevent (see its docblock, and `private-run-access.call-site-ledger.test.ts`). It
 * would also drift in the over-filtering direction the moment the predicate gains a
 * refusal the copy does not have: `not-deployed`, `owner-banned` and `no-iframe-src`
 * each describe a mount that is NOT a private run, and a copy that admits them would
 * suppress impressions the real feature never produced. So this is the predicate's
 * THIRD ledgered caller, deliberately, and the ledger was updated rather than dodged.
 *
 * ── COST, AND WHY THE ORDER IS THE DESIGN ─────────────────────────────────────
 * The beacon is a high-volume, fire-and-forget write — one row per host mount, for
 * every model-page-with-a-block view and every `/apps/run` load — and exists precisely
 * to avoid per-call middleware. The predicate costs 4–9 single-row queries. So the
 * gates run cheapest-first and the expensive one is unreachable on the common path:
 *
 *   1. NO VIEWER → `false`, free. Anonymous can never privately run (gate 2 of the
 *      predicate), and signed-out viewers are the bulk of public impressions.
 *   2. THE APP IS APPROVED → `false`. A `Set.has` against the TTL-cached approved-id
 *      set that `boundAppBlockIdLabel` has ALREADY warmed earlier in the same request,
 *      so on the beacon path this is a cached read, not a query. Every impression on a
 *      live, publicly listed app stops here.
 *   3. THE FLAG IS OFF FOR THIS VIEWER → `false`. An in-process (wasm) Flipt eval with
 *      its own TTL cache — no network. The flag ships BASE-OFF, so today this is where
 *      the remaining traffic stops.
 *   4. Only then the predicate.
 *
 * Net added cost on the common beacon path: for a signed-out viewer, nothing; for a
 * signed-in viewer of an approved app, one already-warm cache read and one set lookup.
 * The database is touched only for a signed-in viewer, of an app confirmed NOT approved,
 * with the flag on — which is the private-run surface itself plus the owner-facing dev
 * tunnel (see the note on shape below).
 *
 * 🔴 STEP 2 MUST FAIL TOWARD RECORDING, AND THAT IS WHY IT IS
 * `isConfirmedNonApprovedAppBlockId` RATHER THAN `!isKnownAppBlockId`. The approved-id
 * cache fails safe to an EMPTY set, which makes every id look non-approved — so the
 * negated form would send EVERY signed-in beacon to the predicate during a database
 * blip, adding queries to an already-failing database on the hottest path in the app.
 * The confirmed form returns `false` when the set is untrusted, so the amplification
 * cannot happen. Note this is purely about load: correctness at step 2 is not required
 * in either direction, because the predicate re-checks the app's status authoritatively.
 *
 * ── SHAPE OF THE SUPPRESSION, AND ITS ONE KNOWN SIDE-EFFECT ───────────────────
 * The `/apps/dev/<blockId>` tunnel also mounts a non-approved app, for its OWNER. With
 * the flag on for that owner, their own dev-tunnel mounts of their own unlisted app stop
 * appearing in their own impressions. That is a bounded, self-affecting change — the
 * only person it can hide a number from is the person generating it, on an app with no
 * public audience — and it is arguably the better default (a private run and a dev run
 * are both authoring activity, not reach). Recorded rather than guarded because
 * discriminating the two mounts would need a trusted per-mount signal, which is exactly
 * what does not exist.
 *
 * What is NOT suppressed: the prom render counter and the launch histograms. Those are
 * internal-only, the app id is clamped to `'other'` for a non-approved app so nothing
 * per-app leaks, and they are the only signal that a review session's host actually
 * mounted. Suppressing the OWNER-VISIBLE rail is the decision; blinding ourselves is
 * not.
 *
 * AUDIT TRAIL: nothing is lost by dropping the row. A private run cannot boot without a
 * token, and the mint writes `app-blocks.private-run.mint` (userId, appBlockId, slug,
 * audience, status, listingStatus, scopes) to Axiom AND stdout, with
 * `app-blocks.private-run.mint-refused` for the refusals. "Who privately ran what, and
 * when" is answerable there, and that internal line — not a ClickHouse row the owner can
 * read — is where the operator decision says the record belongs.
 */
export async function isPrivateRunImpression(args: {
  /** The app the impression is attributed to. Client-chosen; see the derivation note. */
  appBlockId: string;
  /** The SERVER-RESOLVED session user. Never anything parsed from the request body. */
  viewer: SessionUser | undefined | null;
}): Promise<boolean> {
  const { appBlockId, viewer } = args;

  // (1) FREE. Anonymous viewers are the majority of impressions and can never privately
  // run: every private-run audience is a named relationship to the app, or a moderator.
  if (!viewer || typeof viewer.id !== 'number') return false;

  try {
    // (2) CACHED. Confirmed-non-approved only — never the negation; see the docblock.
    if (!(await isConfirmedNonApprovedAppBlockId(appBlockId))) return false;

    // (3) THE KILL-SWITCH, evaluated FOR THIS VIEWER because that is what the predicate
    // requires and refuses to do itself. Dynamically imported so the beacon route's
    // import graph does not eagerly pull Flipt in to do nothing — the same reason the
    // mint defers it.
    const { isAppBlocksPrivateRunEnabled } = await import('~/server/services/app-blocks-flag');
    const privateRunEnabled = await isAppBlocksPrivateRunEnabled({ user: viewer });
    if (!privateRunEnabled) return false;

    // (4) THE REAL PREDICATE. `db: 'read'` — the default, and the replica is right here:
    // this is not a security gate, and a lag window can only mis-decide ONE impression
    // row in either direction. (The predicate still reads the viewer row from the
    // primary itself; that is its own, deliberate, security-shaped divergence.)
    const { resolvePrivateRunAccess } = await import(
      '~/server/services/blocks/private-run-access.service'
    );
    const access = await resolvePrivateRunAccess({
      by: { appBlockId },
      viewer,
      db: 'read',
      privateRunEnabled,
    });
    // ONLY an outright grant suppresses. Every refusal — including `approved`,
    // `not-deployed`, `owner-banned` and `no-iframe-src` — means this mount is not a
    // private run, so the impression is real and must be recorded.
    return access.allowed === true;
  } catch (err) {
    // 🔴 FAIL TOWARD RECORDING THE IMPRESSION. `blockRenders` has no status column and
    // the beacon is fire-and-forget, so a wrongly-dropped row is silent and permanent,
    // while a wrongly-kept one is at worst one review visible to one owner. A thrown
    // flag client or an unreachable replica must not delete an owner's data.
    //
    // 🔴 BUT NOT SILENTLY. A gate that fails open without a trace means the leak is
    // reopened and nothing says so — the reassuring-zero shape. Logged, never thrown,
    // and bounded: this line is only reachable on the rare path (a signed-in viewer, an
    // app confirmed NOT approved, the flag on), so it cannot become a per-impression
    // flood. No app id, no user id — the identifiers are in the mint's audit line, and
    // this is a health signal, not a second audit trail.
    logToAxiom(
      {
        name: 'private-run-impression-gate-failed',
        type: 'error',
        message: 'private-run impression gate failed open; the impression WAS recorded',
        error: err instanceof Error ? err.message : String(err),
      },
      'clickhouse'
    ).catch(() => undefined);
    return false;
  }
}
