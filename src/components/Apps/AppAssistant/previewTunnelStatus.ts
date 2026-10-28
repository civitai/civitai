/** How long the page waits for the app's sandbox to say whether its tunnel is up. */
export const TUNNEL_STATUS_TIMEOUT_MS = 10_000;

/** What the app's sandbox says of its tunnel: running or not, and the host it runs to. */
export interface SandboxTunnelStatus {
  running: boolean;
  host: string | null;
}

/**
 * Asks the app's sandbox (its MCP endpoint, `mcpUrl`, with the user's sandbox token) whether its
 * tunnel is up: the sandbox's own `tunnel_status`, as the server runner asks it. The endpoint is
 * stateless, so one `tools/call` needs no session. Asks for a fresh token once after a 401.
 *
 * `null` whenever the answer is not a clear one — the sandbox did not answer in time, answered with
 * an error status, or said something unreadable. A caller must not read `null` as "down": a sandbox
 * that cannot be reached right now says nothing about the preview.
 *
 * Any authorised request to that endpoint counts as activity for the sandbox's idle clock, so a
 * caller asks only when the user is there (see `AppAssistantPreview`).
 */
export async function fetchSandboxTunnelStatus(
  mcpUrl: string,
  getToken: (opts?: { refresh?: boolean }) => Promise<string>,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  refresh = false
): Promise<SandboxTunnelStatus | null> {
  let res: Response;
  try {
    const token = await getToken(refresh ? { refresh } : undefined);
    res = await fetchImpl(mcpUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'tunnel-status',
        method: 'tools/call',
        params: { name: 'tunnel_status', arguments: {} },
      }),
      signal: AbortSignal.timeout(TUNNEL_STATUS_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (res.status === 401 && !refresh)
    return fetchSandboxTunnelStatus(mcpUrl, getToken, fetchImpl, true);
  if (!res.ok) return null;
  const text = await res.text().catch(() => '');
  return tunnelStatusOf(text);
}

/**
 * The tunnel status in an MCP `tools/call` answer, as JSON or as one server-sent event; `null` when
 * the answer is an error or does not say.
 */
export function tunnelStatusOf(body: string): SandboxTunnelStatus | null {
  const message = parseJson(body) ?? parseJson(lastEventData(body));
  const result = (message as { result?: { isError?: unknown; content?: unknown } } | null)?.result;
  if (!result || result.isError === true || !Array.isArray(result.content)) return null;
  const text = (result.content as { type?: unknown; text?: unknown }[]).find(
    (part) => part?.type === 'text' && typeof part.text === 'string'
  )?.text as string | undefined;
  const status = text === undefined ? null : parseJson(text);
  if (!status || typeof status !== 'object') return null;
  const { running, host } = status as { running?: unknown; host?: unknown };
  if (typeof running !== 'boolean') return null;
  return { running, host: typeof host === 'string' && host ? host : null };
}

function lastEventData(body: string): string {
  const data = body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  return data[data.length - 1] ?? '';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
