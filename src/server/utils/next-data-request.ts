/**
 * A page without getServerSideProps still renders a full document for a `/_next/data` request.
 * Next sets `x-nextjs-data` on such requests when the app has a proxy and leaves `req.url` as the
 * data URL; either marks the request.
 *
 * Its own module, free of `prom-client`, so a page's getServerSideProps can import it without
 * pulling the metrics registry into the page's client test graph.
 */
export function isNextDataRequest(req: {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  return req.headers['x-nextjs-data'] === '1' || !!req.url?.startsWith('/_next/data');
}
