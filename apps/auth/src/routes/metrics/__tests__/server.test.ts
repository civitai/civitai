import { describe, it, expect } from 'vitest';
import { GET } from '../+server';
import { register } from '$lib/server/metrics';

// Build a minimal RequestEvent shape carrying only what the handler reads (request.headers). The handler
// is a plain function — we invoke it directly with a fabricated event.
function eventWithHeaders(headers: Record<string, string>) {
  return {
    request: new Request('http://pod:3000/metrics', { headers }),
  } as unknown as Parameters<typeof GET>[0];
}

describe('/metrics route guard', () => {
  it('returns 404 when X-Forwarded-For is present (request came through the public ingress)', async () => {
    const res = await GET(eventWithHeaders({ 'x-forwarded-for': '203.0.113.7' }));
    expect(res.status).toBe(404);
  });

  it('returns 200 + prometheus text when X-Forwarded-For is absent (direct in-cluster scrape)', async () => {
    const res = await GET(eventWithHeaders({}));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(register.contentType);
    const body = await res.text();
    // A default metric proves register.metrics() was serialized into the body.
    expect(body).toContain('process_cpu_user_seconds_total');
    // And our hub counters are present (exported at 0 before any increment).
    expect(body).toContain('hub_logins_total');
  });
});
