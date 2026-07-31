// App Blocks Analytics Phase 2 — block render/impression beacon (client side).
//
// Fire a block render/impression at the lightweight /api/track/block-render
// beacon instead of the track.blockRender tRPC mutation. This event fires once
// per host mount at BLOCK_READY for every model-page-with-a-block view and every
// /apps/run load, so at GA it's high-volume; the beacon route runs the same
// Tracker.blockRender() (same `blockRenders` ClickHouse insert) WITHOUT the full
// tRPC middleware chain + superjson encode per call (mirrors the #2680
// addView -> /api/track/view move).
//
// `keepalive: true` lets the request survive a page unload/navigation (mirrors
// /api/track/view), so the event isn't lost when the user navigates away right
// as the block becomes ready.
//
// The client supplies ONLY these three identifiers — `isAnon` and `userId` are
// derived/stamped SERVER-SIDE in the beacon route. Never pass them from here.
export type BlockRenderBeaconInput = {
  appBlockId: string;
  blockInstanceId: string;
  slotId: string;
  // Render outcome. Omitted (or 'ok') for the BLOCK_READY success beacon; 'error'
  // when the host detects a genuine render failure (error-boundary trip, or the
  // iframe never reaching BLOCK_READY within its timeout). Drives the
  // `civitai_app_block_renders_total{result}` prom counter server-side.
  status?: 'ok' | 'error';
  // Optional low-cardinality failure discriminator: 'timeout' | 'fatal' |
  // 'no_token' | 'error' | 'error_boundary' | 'token_lost_midsession'.
  //
  // This DRIVES the `error_class` label on the `civitai_app_block_renders_total`
  // prom counter — it is the only thing that can say WHY a render failed, so an
  // alert on that counter can name a cause instead of just "something broke".
  // (The stale comment this replaces said "NOT a prom label"; the label landed in
  // #3119 and the doc never caught up.)
  //
  // 🔴 It is CLAMPED server-side to a code-owned allowlist (KNOWN_ERROR_CLASSES in
  // ~/server/metrics/app-block-runtime.metrics — anything else becomes 'other'),
  // so a value added here is INERT for observability until it is added there too.
  //
  // It is STILL not a ClickHouse column, and that half of the old comment is
  // verified rather than inherited: both writers (the /api/track/block-render
  // beacon route and the track.blockRender tRPC procedure) destructure
  // `status`/`errorClass` OUT before handing the rest to the tracker, and
  // `Tracker.blockRender`'s parameter type has no field for either. So it drives
  // the prom label only.
  errorClass?: string;
  // Mark this as a FOLLOW-UP beacon for a mount that has already reported an
  // outcome (today: the mid-session credential-loss report that follows an `ok`
  // impression). It still drives the prom counter, but the server SKIPS the
  // `blockRenders` ClickHouse insert for it — that table counts impressions, and
  // a second row for one mount would be byte-identical to the first and so
  // impossible to de-duplicate later. Omit (or false) for a mount's FIRST
  // beacon, including a launch failure, which must still be recorded.
  secondary?: boolean;
};

export function sendBlockRender(input: BlockRenderBeaconInput) {
  void fetch('/api/track/block-render', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).catch(() => {
    // Fire-and-forget telemetry: a failed beacon must never surface to the user
    // or throw an unhandled rejection. The server side already retries/logs.
  });
}
