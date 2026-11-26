// Limits shared by the event-points ClickHouse reads that may run past the client's 300 s
// request_timeout. A leaf module: the referee and the award loader it calls both import it.

// The client's request_timeout is a socket idle timer; progress headers keep bytes flowing so a
// query the server still allows is not dropped by the client while the server runs on.
export const LONG_QUERY_PROGRESS_SETTINGS = {
  send_progress_in_http_headers: 1,
  http_headers_progress_interval_ms: '60000',
} as const;

// Past the server's cap the client gives up too: max_execution_time is checked between blocks, so a
// query can overrun it, and progress headers keep the idle timer from ever firing.
export const CLIENT_GRACE_S = 30;

// The client side of a server cap: abandon the request this long after the server should have.
export const clientAbortAfter = (serverCapS: number) =>
  AbortSignal.timeout((serverCapS + CLIENT_GRACE_S) * 1000);
