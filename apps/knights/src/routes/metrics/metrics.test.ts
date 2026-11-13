import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: vi.fn() }));

const { GET } = await import('./+server');

const scrape = (headers: Record<string, string> = {}) =>
  GET({ request: new Request('http://knights.test/metrics', { headers }) } as never);

describe('GET /metrics', () => {
  it('answers 404 to a request that came through the ingress', async () => {
    const response = await scrape({ 'x-forwarded-for': '203.0.113.7' });
    expect(response.status).toBe(404);
  });

  it('serves the exposition text to an in-cluster scrape', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await scrape();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const text = await response.text();
    expect(text).toContain('knights_votes_total{kind="rating"} 0');
    expect(text).toContain('knights_db_up 0');
  });
});
