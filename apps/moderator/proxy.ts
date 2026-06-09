// Intentionally minimal — shadows the main app's src/proxy.ts (Next 16's middleware
// convention) so the moderator app doesn't inherit the main app's middleware. See
// instrumentation.ts for the why.
import type { NextRequest } from 'next/server';
export function proxy(_req: NextRequest) {}
