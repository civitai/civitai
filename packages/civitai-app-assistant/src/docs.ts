import type { AssistantTool } from './tool';

/**
 * `read_docs`: Civitai's developer docs for the server runner's assistant, which has no web tool of
 * its own (the page's has `fetch_page`) and whose sandbox cannot reach the internet. Only Civitai's
 * public developer docs: the setup guide (`SETUP_GUIDE`) and the pages it links all live there.
 */
export const READ_DOCS = 'read_docs';

/** The only host read_docs reads from, over https, redirects included. */
export const DOCS_HOST = 'developer.civitai.com';
/** Characters of a page the assistant gets; the rest is cut with a note saying so. */
export const DOCS_MAX_CHARS = 16_000;
/** How long one read may take, redirects and the body included, before it fails. */
export const DOCS_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
/** Characters of a response body read at all: far above any docs page, and a bound on the work. */
export const DOCS_BODY_MAX_CHARS = 1_000_000;

/** The docs page `raw` names, as read_docs fetches it (no fragment); null when it is not one. */
export function docsUrlOf(raw: unknown, base?: URL): URL | null {
  if (typeof raw !== 'string' || raw.length > 2_000) return null;
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== DOCS_HOST || url.port !== '') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  return url;
}

export interface DocsToolOptions {
  /** The fetch made for every read (the global one when unset; tests inject one). */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxChars?: number;
}

/** A read that failed: its message is what the assistant reads. */
export class DocsReadError extends Error {
  override name = 'DocsReadError';
}

/**
 * read_docs, with its own cache: one tool per reply (the runner builds the reply's tools), so a page
 * read again in the reply is not fetched again. A failed read is not kept, so it can be tried again.
 */
export function createDocsTool(options: DocsToolOptions = {}): AssistantTool {
  const cache = new Map<string, Promise<string>>();
  const read = (url: URL, signal?: AbortSignal) => {
    const key = url.href;
    let pending = cache.get(key);
    if (!pending) {
      pending = fetchDocs(url, options, signal);
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    return pending;
  };
  return {
    description: `Read a page of Civitai's developer docs (https://${DOCS_HOST}/ only), as text. Use it for your setup guide and the pages it links. Pages over ${DOCS_MAX_CHARS.toLocaleString(
      'en-US'
    )} characters are cut, with a note.`,
    activity: 'Reading the developer docs…',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: `A https://${DOCS_HOST}/ address.` },
      },
      required: ['url'],
    },
    async execute(input, context?: { signal?: AbortSignal }) {
      const url = docsUrlOf(input.url);
      if (!url)
        throw new DocsReadError(
          `read_docs reads only https://${DOCS_HOST}/ pages; ${JSON.stringify(
            String(input.url ?? '').slice(0, 200)
          )} is not one.`
        );
      return { url: url.href, text: await read(url, context?.signal) };
    },
  };
}

/** One page, redirects followed only within {@link DOCS_HOST}, as text capped at `maxChars`. */
async function fetchDocs(
  start: URL,
  {
    fetch: fetchImpl = fetch,
    timeoutMs = DOCS_TIMEOUT_MS,
    maxChars = DOCS_MAX_CHARS,
  }: DocsToolOptions,
  outer?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bounds the whole read even when a fetch ignores its signal: it fails, it never hangs.
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new DocsReadError(
          `${start.href} did not answer within ${Math.round(timeoutMs / 1000)} s. Go on without it.`
        )
      );
    }, timeoutMs);
  });
  timedOut.catch(() => undefined);
  try {
    let url = start;
    for (let hop = 0; ; hop++) {
      let response: Response;
      try {
        response = await Promise.race([
          fetchImpl(url.href, {
            redirect: 'manual',
            signal: controller.signal,
            headers: { accept: 'text/markdown, text/plain;q=0.9, text/html;q=0.8' },
          }),
          timedOut,
        ]);
      } catch (error) {
        if (error instanceof DocsReadError) throw error;
        throw new DocsReadError(
          `Could not reach ${DOCS_HOST} (${errorCode(error)}). Go on without it.`
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const next = docsUrlOf(response.headers.get('location') ?? '', url);
        if (!next)
          throw new DocsReadError(
            `${url.href} redirects outside https://${DOCS_HOST}/, which read_docs does not follow.`
          );
        if (hop >= MAX_REDIRECTS)
          throw new DocsReadError(`${start.href} redirects too many times.`);
        url = next;
        continue;
      }
      if (!response.ok)
        throw new DocsReadError(`${DOCS_HOST} answered ${response.status} for ${url.href}.`);
      const type = (response.headers.get('content-type') ?? '').toLowerCase();
      if (type && !/^(text\/|application\/(json|xml|[\w.+-]*\+(json|xml)))/.test(type))
        throw new DocsReadError(`${url.href} is not a text page (${type.split(';')[0]}).`);
      const body = (await Promise.race([response.text(), timedOut])).slice(0, DOCS_BODY_MAX_CHARS);
      const text = type.startsWith('text/html') ? htmlToReadableText(body) : body.trim();
      return capDocs(text, maxChars);
    }
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', abort);
  }
}

/** `text` cut to `maxChars`, with a note of how much was left out. */
export function capDocs(text: string, maxChars: number = DOCS_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[cut: ${(text.length - maxChars).toLocaleString(
    'en-US'
  )} more characters not shown]`;
}

function errorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  if ((error as Error | null)?.name === 'AbortError') return 'stopped';
  return (error as Error | null)?.message?.slice(0, 100) || 'unknown error';
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * An HTML page as readable text: scripts, styles and the head dropped; headings, list items,
 * paragraphs and line breaks kept as markdown-ish lines; code kept as it is. Text only, never
 * rendered as HTML: entities are decoded. Only ever given a page of {@link DOCS_BODY_MAX_CHARS} at most.
 */
export function htmlToReadableText(html: string): string {
  return html
    .replace(/<(script|style|head|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<pre\b[^>]*>/gi, '\n\n```\n')
    .replace(/<\/pre\s*>/gi, '\n```\n\n')
    .replace(
      /<\/?(p|div|section|article|main|header|footer|nav|aside|ul|ol|table|tr|blockquote|h[1-6])\b[^>]*>/gi,
      '\n\n'
    )
    .replace(/<\/?(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
      if (entity[0] === '#') {
        const code =
          entity[1] === 'x' || entity[1] === 'X'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[entity.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
