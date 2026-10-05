import client from 'prom-client';
import { PROM_PREFIX } from '@civitai/telemetry/client';
// TYPE-ONLY, so this metrics module does not pull the projection's graph — and so
// the label domain cannot drift from the decision it labels. The union is declared
// beside the decision (`post-app-chip.logic.ts`) rather than here, because it
// describes the branches that exist, not the counter that counts them.
import type { PostAppChipOutcome } from '~/server/services/blocks/post-app-chip.logic';

/**
 * POST-DETAIL app-chip read metrics.
 *
 * ## Why this exists
 *
 * `readPostAppChip` FAILS OPEN: it is decoration on a page that must render, so
 * any error returns `null` and the post page comes up without a chip. That is the
 * right behaviour and it has one bad property — **`null` is also what a post with
 * no marker returns**. So a total failure of the read (a dropped replica, a
 * renamed column, a Prisma client that cannot see the relation) is
 * indistinguishable, from outside, from the ordinary and overwhelmingly common
 * case of an ordinary post. The chip would simply stop existing site-wide and
 * nothing would report it.
 *
 * The Axiom log on that branch names each individual failure but cannot answer
 * "is this happening at a rate", which is the only question that distinguishes a
 * one-off from the feature being dead. This counter can.
 *
 * `outcome` partitions the branches that are otherwise all `null` on the wire:
 *   - `chip`        — a chip was produced (the feature working).
 *   - `no-marker`   — gated through, read the marker, there wasn't one. The
 *                     common path.
 *   - `unresolved`  — a marker that resolved to no app, or to no nameable one.
 *                     Reachable BY DESIGN (the dev-scoped mint path writes a
 *                     deliberately synthetic appId), so a non-zero rate here is
 *                     normal and a rate of ZERO alongside `chip` traffic is the
 *                     odd reading.
 *   - `gated`       — the viewer's store scope does not admit an on-site listing.
 *                     Dominant while the store is dark; its share falling to zero
 *                     is how the launch looks from here.
 *   - `degraded`    — the fail-open catch fired. **This is the alertable one.**
 *
 * Bounded at five series, and deliberately NOT labelled by app, post, user or
 * scope: this is a public, anon-capable, high-traffic read, and any of those
 * would be unbounded cardinality.
 *
 * 🔴 It is NOT a substitute for the store-scope counters in
 * `store-scope.metrics.ts`. Those answer "what did the resolver decide, and did
 * the branch receive it"; this one answers "what did this surface do about it".
 * `gated` here and `store_scope_applied_total{entrypoint="post-detail"}` are two
 * views of the same decision on purpose — if they ever disagree, the scope is
 * being lost between the resolver and this branch.
 *
 * Pinned on globalThis so an HMR re-eval / a second request-graph eval reuse the
 * one instance instead of throwing prom-client's duplicate-registration error
 * (the same trap documented for the store-scope and http-error counters).
 */

declare global {
  // eslint-disable-next-line no-var
  var __civitaiPostAppChipMetrics: { reads: client.Counter<string> } | undefined;
}

const metrics =
  globalThis.__civitaiPostAppChipMetrics ??
  (globalThis.__civitaiPostAppChipMetrics = {
    reads: new client.Counter({
      name: PROM_PREFIX + 'post_app_chip_reads_total',
      help:
        'Cumulative post-detail "Published with <app>" chip resolutions, by outcome: ' +
        '`chip` (a chip was produced), `no-marker` (not an app-published post — the common ' +
        'path), `unresolved` (a marker resolving to no nameable app; reachable by design via ' +
        "the dev-scoped mint path, so a nonzero rate is normal), `gated` (the viewer's store " +
        'scope does not admit an on-site listing; dominant while the store is dark) and ' +
        '`degraded` (the fail-open catch fired). ' +
        'Monotonic; use rate(). ALERT ON `degraded`: the read returns null on failure exactly ' +
        'as it does for an ordinary post, so without this counter the chip can disappear ' +
        'site-wide with no other signal. A `chip` rate falling to zero while `no-marker` ' +
        'continues is the same fault seen from the other side.',
      labelNames: ['outcome'],
    }),
  });

/** Record one chip resolution. Never throws — telemetry must not break a read. */
export function recordPostAppChipRead(outcome: PostAppChipOutcome): void {
  try {
    metrics.reads.inc({ outcome });
  } catch {
    /* never throw from telemetry — a fail-open path must not be made to fail */
  }
}
