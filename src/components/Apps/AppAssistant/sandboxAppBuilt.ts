import { exitCodeOf } from '@civitai/app-assistant';
import { callSandboxTool, toolResultOf } from '~/components/Apps/AppAssistant/previewTunnelStatus';

/**
 * Lists every top-level project's manifest (`<dir>/block.manifest.json`), one path a line, as the
 * server runner's own lookup for where to open the preview does (`#projectDir` in the runner's
 * `app-assistant/preview.ts`).
 */
export const LIST_MANIFESTS_COMMAND =
  'for f in */block.manifest.json; do [ -f "$f" ] && printf "%s\\n" "$f"; done; exit 0';

/** How long the page waits for the listing: a shell loop over a handful of directories. */
const LIST_TIMEOUT_MS = 10_000;

/**
 * Whether the app has been built far enough to preview: its sandbox holds at least one project
 * manifest, `<dir>/block.manifest.json` in any top-level directory. The server runner opens the
 * preview, Restart preview included, from the project it finds there: the directory the dev server
 * last ran in, the one named for the app's key, or the only top-level one with a manifest. Every one
 * of those is such a directory, so an app the runner could restart is never reported unbuilt. An app
 * with none has never had a preview and has none to restart. Asked with the sandbox's own
 * `run_command`, as one stateless `tools/call`.
 *
 * `true` when the listing names at least one manifest, `false` only when the listing ran and named
 * none, and `null` when there is no clear answer (no answer in time, an error status, a failed or
 * unreadable command): a caller must not read `null` as "not built".
 */
export async function fetchSandboxAppBuilt(
  mcpUrl: string,
  getToken: (opts?: { refresh?: boolean }) => Promise<string>,
  // The app asked about. Its sandbox holds only its own files, so the listing needs no name.
  _app: string,
  fetchImpl?: typeof fetch
): Promise<boolean | null> {
  const body = await callSandboxTool(
    mcpUrl,
    getToken,
    'run_command',
    { command: LIST_MANIFESTS_COMMAND, timeout_ms: LIST_TIMEOUT_MS },
    fetchImpl
  );
  const result = body === null ? null : toolResultOf(body);
  if (!result || result.isError || result.text === undefined) return null;
  if (exitCodeOf(result.text) !== 0) return null;
  // `run_command` answers its exit code and status, then `---`, then what the command printed.
  const at = result.text.indexOf('\n---\n');
  if (at < 0) return null;
  const listed = result.text
    .slice(at + 5)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('/block.manifest.json'));
  return listed.length > 0;
}
