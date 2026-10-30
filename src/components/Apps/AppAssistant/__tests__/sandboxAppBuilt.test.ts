import { describe, expect, it, vi } from 'vitest';
import { fetchSandboxAppBuilt } from '~/components/Apps/AppAssistant/sandboxAppBuilt';
import { fakeSandboxFiles } from '~/components/Apps/AppAssistant/__tests__/fakeSandboxFiles';

const MCP = 'https://sandbox.example/mcp/sb-tip-calc-3';
const answer = (text: string, isError = false) =>
  new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'run_command',
      result: { content: [{ type: 'text', text }], isError },
    })
  );

describe('fetchSandboxAppBuilt', () => {
  it('lists the sandbox’s project manifests with the user’s sandbox token', async () => {
    const sandbox = fakeSandboxFiles(['tip-calc/block.manifest.json']);
    expect(await fetchSandboxAppBuilt(MCP, async () => 'tok-1', 'tip-calc', sandbox.fetch)).toBe(
      true
    );
    const [url, init] = sandbox.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(MCP);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-1');
    expect(JSON.parse(String(init.body))).toMatchObject({
      method: 'tools/call',
      params: { name: 'run_command' },
    });
  });

  it('finds a project that lives outside the directory named for the app’s key', async () => {
    // Where the runner's own lookup finds it (the only top-level manifest), so Restart would work.
    const sandbox = fakeSandboxFiles(['tip-calc-v2/block.manifest.json', 'notes/todo.md']);
    expect(await fetchSandboxAppBuilt(MCP, async () => 'tok', 'tip-calc', sandbox.fetch)).toBe(
      true
    );
  });

  it('is false only when the listing ran and found no manifest', async () => {
    const sandbox = fakeSandboxFiles(['notes/todo.md', 'block.manifest.json']);
    expect(await fetchSandboxAppBuilt(MCP, async () => 'tok', 'tip-calc', sandbox.fetch)).toBe(
      false
    );
  });

  it('is null — never “not built” — with no clear answer', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const failing = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    const garbled = vi.fn(async () => new Response('<html>oops</html>'));
    const refused = vi.fn(async () => answer('The sandbox is not running.', true));
    const crashed = vi.fn(async () => answer('exit_code: 1\ntimed_out: false\n---\nboom'));
    const headless = vi.fn(async () => answer('something else'));
    for (const fetchImpl of [down, failing, garbled, refused, crashed, headless])
      expect(await fetchSandboxAppBuilt(MCP, async () => 'tok', 'tip-calc', fetchImpl)).toBeNull();
  });
});
