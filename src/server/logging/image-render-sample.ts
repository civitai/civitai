/**
 * Sampled log of signed-in `/images/[imageId]` HTML renders, for sizing an edge cache of the
 * static shell before building it. Each line's own record timestamp allows a sliding 60 s window
 * per (imageId, colo): how often the same image URL is rendered again at the same Cloudflare colo
 * within 60 s of a previous render.
 *
 * - Dark until the Flipt boolean `shell-images-render-sample` (`shellImagesRenderSample`) is on,
 *   evaluated with no user, so it is one switch for everyone.
 * - At most `IMAGE_RENDER_SAMPLE_MAX_PER_SEC` lines per process per 1 s tumbling window. A line
 *   emitted after the cap dropped some carries `droppedSinceLastLog`, so a binding cap is visible.
 * - PRIVACY: the line carries the numeric image id and the colo, nothing else —
 *   no user id, cookie, IP, user agent or URL. (`logToAxiom` adds the process's pod name.)
 * - Never throws and is not awaited by `_document`: losing a line is fine, delaying a render is not.
 */
import type { ParsedUrlQuery } from 'querystring';
import { renderAuthedLabel } from '~/server/prom/route-traffic.metrics';
import { ssrRequestKind } from '~/server/prom/ssr-cpu.metrics';

export const IMAGE_RENDER_SAMPLE_ROUTE = '/images/[imageId]';
export const IMAGE_RENDER_SAMPLE_LOG_NAME = 'shell-images-render-sample';
export const IMAGE_RENDER_SAMPLE_MAX_PER_SEC = 20;

const IMAGE_ID_RE = /^[1-9][0-9]{0,14}$/;
const COLO_RE = /^[A-Z]{3}$/;

/** The colo from a `cf-ray` header (`<ray id>-<IATA code>`), or `unknown`. */
export function cfRayColo(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return 'unknown';
  const dash = value.lastIndexOf('-');
  if (dash < 1) return 'unknown';
  const colo = value.slice(dash + 1);
  return COLO_RE.test(colo) ? colo : 'unknown';
}

/** The request as `_app.getInitialProps` leaves it (see `renderAuthedLabel`). */
type SampleRequest = {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  session?: { user?: unknown } | null;
  sessionUnresolved?: boolean;
};

let windowStartMs = 0;
let countThisWindow = 0;
let droppedSinceEmit = 0;

/** -1 to drop this line, else the number of lines dropped since the last one emitted. */
function takeSlot(now: number): number {
  if (now - windowStartMs >= 1000) {
    windowStartMs = now;
    countThisWindow = 0;
  }
  if (countThisWindow >= IMAGE_RENDER_SAMPLE_MAX_PER_SEC) {
    droppedSinceEmit++;
    return -1;
  }
  countThisWindow++;
  const dropped = droppedSinceEmit;
  droppedSinceEmit = 0;
  return dropped;
}

/** TEST-ONLY: reset the per-process rate window. */
export function __resetImageRenderSampleForTest() {
  windowStartMs = 0;
  countThisWindow = 0;
  droppedSinceEmit = 0;
}

async function isSampleFlagOn(req: SampleRequest): Promise<boolean> {
  const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
  const host = req.headers.host;
  const flags = await getFeatureFlagsAsync({ host: Array.isArray(host) ? host[0] : host });
  return flags.shellImagesRenderSample === true;
}

/**
 * Called from `_document.getInitialProps` for every rendered document; `route` is the rendered
 * page pattern (a notFound arrives as `/404`), `query` the route query.
 */
export async function sampleImageRender(
  route: string,
  query: ParsedUrlQuery | undefined,
  req: SampleRequest,
  now: number = Date.now()
): Promise<void> {
  try {
    if (typeof window !== 'undefined') return;
    if (route !== IMAGE_RENDER_SAMPLE_ROUTE) return;
    if (renderAuthedLabel(req) !== 'true') return;
    if (ssrRequestKind(req) !== 'html') return;
    const rawId = query?.imageId;
    if (typeof rawId !== 'string' || !IMAGE_ID_RE.test(rawId)) return;
    if (!(await isSampleFlagOn(req))) return;
    const dropped = takeSlot(now);
    if (dropped < 0) return;

    const { logToAxiom } = await import('~/server/logging/client');
    await logToAxiom({
      name: IMAGE_RENDER_SAMPLE_LOG_NAME,
      type: 'info',
      imageId: Number(rawId),
      colo: cfRayColo(req.headers['cf-ray']),
      ...(dropped > 0 ? { droppedSinceLastLog: dropped } : {}),
    });
  } catch {
    // Losing one line is fine.
  }
}
