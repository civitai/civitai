import { describe, expect, it, vi } from 'vitest';
import { fetchSandboxAppBuilt } from '~/components/Apps/AppAssistant/sandboxAppBuilt';

const MCP = 'https://sandbox.example/mcp/sb-tip-calc-3';
/** `tools/call`'s answer for `read_file`, as sandbox-mcp gives it. */
const answer = (text: string, isError = false) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 'read_file',
    result: { content: [{ type: 'text', text }], isError },
  });

describe('fetchSandboxAppBuilt', () => {
  it('reads the app’s block.manifest.json with the user’s sandbox token: read means built', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          answer(JSON.stringify({ path: 'tip-calc/block.manifest.json', content: '{}' }))
        )
    );
    expect(await fetchSandboxAppBuilt(MCP, async () => 'tok-1', 'tip-calc', fetchImpl)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(MCP);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-1');
    expect(JSON.parse(String(init.body))).toMatchObject({
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'tip-calc/block.manifest.json' } },
    });
  });

  it('is false when the sandbox says it cannot read it: nothing scaffolded yet', async () => {
    const fetchImpl = vi.fn(async () => new Response(answer('ENOENT: no such file', true)));
    expect(await fetchSandboxAppBuilt(MCP, async () => 'tok', 'tip-calc', fetchImpl)).toBe(false);
  });

  it('is null — never “not built” — with no clear answer', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const failing = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    const garbled = vi.fn(async () => new Response('<html>oops</html>'));
    for (const fetchImpl of [down, failing, garbled])
      expect(await fetchSandboxAppBuilt(MCP, async () => 'tok', 'tip-calc', fetchImpl)).toBeNull();
  });
});
