import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Liveness/readiness probe for k8s. Intentionally does NO DB/redis work — a liveness probe must be
// fast and must not flap on a transient backend blip (which would needlessly restart the pod). If a
// dependency-aware readiness check is ever needed, add it as a separate endpoint.
export const GET: RequestHandler = () => json({ status: 'ok' });
