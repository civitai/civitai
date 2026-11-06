export const PAGE_ROUTE_HEADER = 'x-page-route';

/**
 * Set on the page request by `_app.getInitialProps` to the page's route pattern (`ctx.pathname`,
 * e.g. `/models/[id]/[[...slug]]`). Next runs `_app`'s getInitialProps before the page's
 * getServerSideProps, which has no pattern of its own (only the URL), so this is how the data
 * phase's CPU metric is labelled by route. Here rather than in `~/server` so `_app` needs no
 * server import.
 */
export const PAGE_ROUTE_REQ_KEY = 'civPageRoute';
