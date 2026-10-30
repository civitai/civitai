import { callSandboxTool, toolResultOf } from '~/components/Apps/AppAssistant/previewTunnelStatus';

/**
 * Whether the app has been built far enough to preview: its project's `block.manifest.json` (in the
 * directory named for the app's key, where the assistant scaffolds it) exists in the app's sandbox.
 * It is the file the server runner reads to open the preview, Restart preview included, so an app
 * without it has never had a preview and has none to restart. Asked with the sandbox's own
 * `read_file`, as one stateless `tools/call`.
 *
 * `true` when the file was read, `false` when the sandbox said it could not read it (no such file),
 * and `null` when there is no clear answer (no answer in time, an error status, a body it cannot
 * read): a caller must not read `null` as "not built".
 */
export async function fetchSandboxAppBuilt(
  mcpUrl: string,
  getToken: (opts?: { refresh?: boolean }) => Promise<string>,
  app: string,
  fetchImpl?: typeof fetch
): Promise<boolean | null> {
  const body = await callSandboxTool(
    mcpUrl,
    getToken,
    'read_file',
    { path: `${app}/block.manifest.json` },
    fetchImpl
  );
  const result = body === null ? null : toolResultOf(body);
  if (!result) return null;
  return !result.isError;
}
