import { describe, expect, it, vi } from 'vitest';
import {
  fetchSandboxTunnelStatus,
  tunnelStatusOf,
} from '~/components/Apps/AppAssistant/previewTunnelStatus';

const MCP = 'https://sandbox.example/mcp/sb-tip-calc-3';
const HOST = 'dev-1a2b3c4d5e6f7081.apps.example';
/** `tools/call`'s answer for `tunnel_status`, as sandbox-mcp gives it: the status as JSON text. */
const answer = (status: unknown, isError = false) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 'tunnel-status',
    result: { content: [{ type: 'text', text: JSON.stringify(status) }], isError },
  });

describe('tunnelStatusOf', () => {
  it('reads running and host from a JSON answer and from a server-sent event', () => {
    expect(tunnelStatusOf(answer({ running: true, host: HOST, pid: 7 }))).toEqual({
      running: true,
      host: HOST,
    });
    expect(
      tunnelStatusOf(`event: message\ndata: ${answer({ running: false, host: null })}\n\n`)
    ).toEqual({ running: false, host: null });
  });

  it('is null for an error result, a status with no `running`, or text that is not JSON', () => {
    expect(tunnelStatusOf(answer({ running: true, host: HOST }, true))).toBeNull();
    expect(tunnelStatusOf(answer({ host: HOST }))).toBeNull();
    expect(tunnelStatusOf('<html>bad gateway</html>')).toBeNull();
  });
});

describe('fetchSandboxTunnelStatus', () => {
  it('calls the sandbox’s tunnel_status with the user’s sandbox token', async () => {
    const fetchImpl = vi.fn(async () => new Response(answer({ running: true, host: HOST })));
    const status = await fetchSandboxTunnelStatus(MCP, async () => 'tok-sandbox-1', fetchImpl);
    expect(status).toEqual({ running: true, host: HOST });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(MCP);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-sandbox-1');
    expect(JSON.parse(String(init.body))).toMatchObject({
      method: 'tools/call',
      params: { name: 'tunnel_status', arguments: {} },
    });
  });

  it('asks once more with a fresh token after a 401', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(answer({ running: false, host: null })));
    const tokens: unknown[] = [];
    const status = await fetchSandboxTunnelStatus(
      MCP,
      async (opts) => {
        tokens.push(opts);
        return 'tok';
      },
      fetchImpl
    );
    expect(status).toEqual({ running: false, host: null });
    expect(tokens).toEqual([undefined, { refresh: true }]);
  });

  it('is null — never “down” — when the sandbox cannot be reached or answers an error status', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await fetchSandboxTunnelStatus(MCP, async () => 'tok', down)).toBeNull();
    const bad = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    expect(await fetchSandboxTunnelStatus(MCP, async () => 'tok', bad)).toBeNull();
  });
});
