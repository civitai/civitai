import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Liveness probe for k8s. Intentionally does NO DB/redis work — a liveness probe must be fast and must
// not flap on a transient backend blip (which would needlessly restart the pod). The Redis-aware
// readiness check is /api/ready.
export const GET: RequestHandler = () => json({ status: 'ok' });
