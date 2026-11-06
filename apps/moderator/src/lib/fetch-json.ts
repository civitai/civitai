const SNIPPET_CHARS = 120;

/** What a non-JSON body says, in a line: an HTML page's `<title>` (a proxy or edge error page names its
 *  fault there), else the start of the text. */
function describeBody(text: string): string {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1];
  const line = (title ?? text).replace(/\s+/g, ' ').trim();
  return line.length > SNIPPET_CHARS ? `${line.slice(0, SNIPPET_CHARS)}…` : line;
}

function errorField(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  // `error` is what this app's handlers return; `message` is what SvelteKit's `error()` serialises.
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (typeof error === 'string') return error;
  if (typeof message === 'string') return message;
  return null;
}

/** A JSON GET that rejects on a non-2xx status, so an `{#await}` lands in `{:catch}` with the status
 *  rather than rendering an error body as data. A body that is not JSON — an edge or proxy error page,
 *  a login page after a redirect — rejects with its status and what it says, never a parse error. */
export const fetchJson = <T>(url: string): Promise<T> =>
  fetch(url).then(async (r) => {
    const text = await r.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      const said = describeBody(text);
      throw new Error(`HTTP ${r.status}${said ? `: ${said}` : ''}`);
    }
    if (!r.ok) throw new Error(errorField(body) ?? `Request failed (${r.status})`);
    return body as T;
  });
