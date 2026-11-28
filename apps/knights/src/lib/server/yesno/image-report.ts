import { env } from '$env/dynamic/private';
import { mainAppBase } from '../main-app-base';
import { IMAGE_GONE } from './report';

/** The route's 404 body for an image it does not have (`kono-report-image.ts`). */
const IMAGE_NOT_FOUND = 'Image not found';

/**
 * Files one main-app Report on a pulled image through the main app's own report service, authenticated like the rating
 * write-back (`queue/main-app.ts`). The main app fixes the reason and text; only the image id is sent. A throw means
 * nothing is known to be filed, so the caller files again later; the main app returns the report it already filed for a
 * repeat. `IMAGE_GONE` is the route's own 404 for an image it does not have; any other 404 (a route not deployed yet) is
 * a throw.
 */
export async function reportImageToMainApp(imageId: number): Promise<number | typeof IMAGE_GONE> {
  const token = env.WEBHOOK_TOKEN;
  if (!token) throw new Error('WEBHOOK_TOKEN is not configured');

  const res = await fetch(`${mainAppBase()}/api/mod/image/kono-report-image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-token': token },
    body: JSON.stringify({ imageId }),
    signal: AbortSignal.timeout(8000),
  });
  const body = (await res.json().catch(() => null)) as {
    reportId?: unknown;
    error?: unknown;
  } | null;
  if (res.status === 404 && body?.error === IMAGE_NOT_FOUND) return IMAGE_GONE;
  if (!res.ok) throw new Error(`main app refused the image report (${res.status})`);
  const reportId = body?.reportId;
  if (typeof reportId !== 'number' || !Number.isInteger(reportId) || reportId <= 0)
    throw new Error('main app answered the image report without a report id');
  return reportId;
}
