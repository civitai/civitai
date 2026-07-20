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
  // Optional low-cardinality failure discriminator (e.g. 'timeout', 'fatal',
  // 'no_token', 'error_boundary'). Accepted + bounded server-side; reserved for a
  // future ClickHouse column (NOT a prom label, NOT in the CH insert today).
  errorClass?: string;
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
