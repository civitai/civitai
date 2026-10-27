import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '../fetch-json';

const respond = (body: string, status = 200, contentType = 'application/json') =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, headers: { 'content-type': contentType } }))
  );

afterEach(() => vi.unstubAllGlobals());

describe('fetchJson', () => {
  it('resolves a JSON body', async () => {
    respond('{"items":[1]}');
    await expect(fetchJson('/x')).resolves.toEqual({ items: [1] });
  });

  // The moderator saw `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, which names no status
  // and no layer.
  it('names the status and the page title of an HTML error page, not a parse error', async () => {
    respond(
      '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>…</body></html>',
      502,
      'text/html'
    );
    await expect(fetchJson('/x')).rejects.toThrow(/^HTTP 502: 502 Bad Gateway$/);
  });

  it('names the status of a non-JSON body that came back 200, such as a login page after a redirect', async () => {
    respond('<!DOCTYPE html><html><head><title>Sign in</title></head></html>', 200, 'text/html');
    await expect(fetchJson('/x')).rejects.toThrow(/^HTTP 200: Sign in$/);
  });

  it('falls back to the start of the text when there is no title, capped', async () => {
    respond(`upstream   timed\nout ${'x'.repeat(300)}`, 504, 'text/plain');
    const err = await fetchJson('/x').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^HTTP 504: upstream timed out x+…$/);
    expect((err as Error).message.length).toBeLessThan(140);
  });

  it("surfaces a handler's own `error` on a non-2xx JSON body", async () => {
    respond('{"error":"Could not reach the orchestrator."}', 502);
    await expect(fetchJson('/x')).rejects.toThrow(/^Could not reach the orchestrator\.$/);
  });

  it("surfaces SvelteKit error()'s `message` on a non-2xx JSON body", async () => {
    respond('{"message":"You do not have access to this page."}', 403);
    await expect(fetchJson('/x')).rejects.toThrow(/^You do not have access to this page\.$/);
  });

  it('names the status when a non-2xx JSON body carries no message', async () => {
    respond('{}', 500);
    await expect(fetchJson('/x')).rejects.toThrow(/^Request failed \(500\)$/);
  });
});
