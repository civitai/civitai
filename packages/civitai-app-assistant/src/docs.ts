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

/** The `offset` read_docs was given: a whole number of characters, 0 when unset; null when invalid. */
export function docsOffsetOf(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

interface CachedRead {
  /** The whole page as text, before any cut: an `offset` read is served from it. */
  page: Promise<string>;
  /** Aborts the fetch; only when every caller waiting on it has stopped. */
  controller: AbortController;
  waiting: number;
  settled: boolean;
}

/**
 * read_docs, with its own cache: one tool per reply (the runner builds the reply's tools), so a page
 * read again in the reply, at any offset, is not fetched again. A failed read is not kept, so it can be
 * tried again. Callers share one fetch: a caller that is stopped (its signal aborts) stops waiting, but
 * the fetch goes on for the others; only when none is left waiting is it aborted and dropped.
 */
export function createDocsTool(options: DocsToolOptions = {}): AssistantTool {
  const maxChars = options.maxChars ?? DOCS_MAX_CHARS;
  const cache = new Map<string, CachedRead>();
  const drop = (key: string, entry: CachedRead) => {
    if (cache.get(key) === entry) cache.delete(key);
  };
  const read = (url: URL, signal?: AbortSignal): Promise<string> => {
    if (signal?.aborted) return Promise.reject(stopped());
    const key = url.href;
    let entry = cache.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: CachedRead = {
        page: fetchDocs(url, options, controller.signal),
        controller,
        waiting: 0,
        settled: false,
      };
      created.page.then(
        () => {
          created.settled = true;
        },
        () => {
          created.settled = true;
          drop(key, created);
        }
      );
      cache.set(key, created);
      entry = created;
    }
    const shared = entry;
    shared.waiting++;
    return new Promise<string>((resolve, reject) => {
      let done = false;
      const finish = () => {
        done = true;
        shared.waiting--;
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (done) return;
        finish();
        if (shared.waiting === 0 && !shared.settled) {
          shared.controller.abort();
          drop(key, shared);
        }
        reject(stopped());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      shared.page.then(
        (page) => {
          if (done) return;
          finish();
          resolve(page);
        },
        (error) => {
          if (done) return;
          finish();
          reject(error);
        }
      );
    });
  };
  return {
    description: `Read a page of Civitai's developer docs (https://${DOCS_HOST}/ only), as text. Use it for your setup guide and the pages it links. A read returns at most ${maxChars.toLocaleString(
      'en-US'
    )} characters; a longer page ends with a note naming the offset to pass to read on.`,
    activity: 'Reading the developer docs…',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: `A https://${DOCS_HOST}/ address.` },
        offset: {
          type: 'integer',
          minimum: 0,
          description:
            'Characters of the page to skip: 0 (the default) reads from the start; pass the offset a cut note names to read on.',
        },
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
      const offset = docsOffsetOf(input.offset);
      if (offset === null)
        throw new DocsReadError(
          'read_docs: offset must be a whole number of characters, 0 or more.'
        );
      const page = await read(url, context?.signal);
      if (offset > 0 && offset >= page.length)
        throw new DocsReadError(
          `${url.href} is ${page.length.toLocaleString(
            'en-US'
          )} characters; offset ${offset.toLocaleString('en-US')} is past its end.`
        );
      return { url: url.href, text: capDocs(page, maxChars, offset) };
    },
  };
}

function stopped(): DocsReadError {
  return new DocsReadError('read_docs was stopped.');
}

/** One page, redirects followed only within {@link DOCS_HOST}, as text, uncut (the caller cuts it). */
async function fetchDocs(
  start: URL,
  { fetch: fetchImpl = fetch, timeoutMs = DOCS_TIMEOUT_MS }: DocsToolOptions,
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
      const body = await Promise.race([readBody(response, DOCS_BODY_MAX_CHARS), timedOut]);
      return type.startsWith('text/html') ? htmlToReadableText(body) : body.trim();
    }
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', abort);
  }
}

/** At most `maxChars` characters of a response body: read as a stream, which is cancelled at the cap. */
export async function readBody(response: Response, maxChars: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return text.slice(0, maxChars);
}

/**
 * At most `maxChars` characters of `text` from `offset` on. A part that does not reach the end says
 * how much is left and the offset to read on from; a part that starts past 0 says where it starts.
 */
export function capDocs(text: string, maxChars: number = DOCS_MAX_CHARS, offset = 0): string {
  const n = (value: number) => value.toLocaleString('en-US');
  const end = offset + maxChars;
  const part = text.slice(offset, end);
  const from = offset > 0 ? `[from character ${n(offset)} of ${n(text.length)}]\n\n` : '';
  if (end >= text.length) return `${from}${part}`;
  return `${from}${part}\n\n[cut: ${n(
    text.length - end
  )} more characters not shown; read on with offset ${end}]`;
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
