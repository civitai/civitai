import { vi } from 'vitest';

/**
 * A sandbox MCP endpoint over a fixed set of files, answering the two calls the page makes about a
 * project as sandbox-mcp does: `read_file` (the file's JSON, or an error for a missing one) and
 * `run_command` for the manifest listing (each top-level `<dir>/block.manifest.json`, as the shell
 * loop prints it). Any other command answers an error, so a test cannot pass on a call it did not mean.
 */
export function fakeSandboxFiles(paths: string[]) {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { params } = JSON.parse(String(init?.body)) as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    const reply = (text: string, isError = false) =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: params.name,
          result: { content: [{ type: 'text', text }], isError },
        })
      );
    if (params.name === 'read_file') {
      const path = String(params.arguments.path);
      return paths.includes(path)
        ? reply(JSON.stringify({ path, content: '{}' }))
        : reply(`ENOENT: no such file or directory, open '${path}'`, true);
    }
    const command = String(params.arguments.command ?? '');
    if (params.name === 'run_command' && command.includes('*/block.manifest.json')) {
      const listed = paths.filter((path) => /^[^/]+\/block\.manifest\.json$/.test(path));
      return reply(`exit_code: 0\ntimed_out: false\n---\n${listed.map((p) => `${p}\n`).join('')}`);
    }
    return reply(`not a call this fake answers: ${params.name}`, true);
  });
  return { fetch };
}
