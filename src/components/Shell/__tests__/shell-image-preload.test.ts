// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptShellPageData,
  encodeShellMainImageHeader,
  SHELL_MAIN_IMAGE_HEADER,
  SHELL_PAGE_DATA_REQUIRED_KEYS,
  shellPageDataPrefetchScript,
} from '~/components/Shell/shell-page-data';

/**
 * The shell's inline head script preloads the page's main image from the page-data answer
 * (`shellPageDataPrefetchScript`). Run here as `_document` ships it — the script TEXT, through
 * `new Function` — against a stubbed `fetch`. Contracts: exactly one preload, with the attributes
 * that make it the high-priority image request the `<img>` later reuses, for a 200 whose headers
 * name a URL; added before the body has arrived; none for anything else; and the app's own read of
 * the body still works afterwards.
 */

// Distinct from anything the script or the endpoint could produce by default, spaces and a
// non-ASCII character included (an `<img>` tolerates them, and so must the preload; a raw header
// value could carry neither).
const IMAGE_URL = 'https://image.example/abc-123/original=true/My Picture 7 café.jpeg';
const IMAGE_HEADER = { [SHELL_MAIN_IMAGE_HEADER]: encodeShellMainImageHeader(IMAGE_URL) };

const pageData = (extra: Record<string, unknown> = {}) => ({
  ...Object.fromEntries(SHELL_PAGE_DATA_REQUIRED_KEYS.map((key) => [key, null])),
  flags: {},
  region: {},
  adsGated: false,
  trpcState: {},
  ...extra,
});

// Every promise the script can be waiting on: each fetch answer, and each body read off a
// response (or a clone of it). `settle` waits for all of them.
let pending: Promise<unknown>[] = [];

function track(response: Response): Response {
  const { clone, json, text } = response;
  response.clone = () => track(clone.call(response));
  response.json = () => {
    const read = json.call(response);
    pending.push(read);
    return read;
  };
  response.text = () => {
    const read = text.call(response);
    pending.push(read);
    return read;
  };
  return response;
}

function stubFetch(respond: () => Promise<Response>) {
  const fetchMock = vi.fn(() => {
    const answer = respond().then(track);
    pending.push(answer);
    return answer;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const preloads = () => Array.from(document.head.querySelectorAll('link[rel="preload"]'));

/**
 * Waits until the script's chain (fetch → clone → json → append) has run out, however slow the
 * box. The script attaches its reactions to each tracked promise before `settle` does, so once
 * `allSettled` over them resolves the script's callbacks have run; a callback that starts a
 * further read adds to `pending`, so loop until a pass adds none.
 */
async function settle() {
  let seen = 0;
  while (seen < pending.length) {
    seen = pending.length;
    await Promise.allSettled(pending);
  }
}

function runScript() {
  new Function(shellPageDataPrefetchScript())();
}

beforeEach(() => {
  pending = [];
  window.history.replaceState(null, '', '/images/123');
});

afterEach(() => {
  for (const link of preloads()) link.remove();
  delete window.__civShell;
  vi.unstubAllGlobals();
});

describe('the shell head script preloads the main image', () => {
  it('adds exactly one high-priority image preload for the URL the page data names', async () => {
    stubFetch(async () => json(pageData(), 200, IMAGE_HEADER));
    runScript();
    await settle();

    const links = preloads();
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(link.parentElement).toBe(document.head);
    expect({
      rel: link.getAttribute('rel'),
      as: link.getAttribute('as'),
      fetchpriority: link.getAttribute('fetchpriority'),
      href: link.getAttribute('href'),
      crossorigin: link.getAttribute('crossorigin'),
    }).toEqual({
      rel: 'preload',
      as: 'image',
      fetchpriority: 'high',
      // Byte for byte: the `<img>` gets this string too, and the browser parses both alike.
      href: IMAGE_URL,
      // An `<img>` without `crossorigin` is a no-cors request; a preload in any other mode would
      // not be reused by it.
      crossorigin: null,
    });
  });

  it('adds it from the headers alone, before the body has arrived', async () => {
    // The body never completes: a preload that waited for it would never be added. On a real
    // load the body is the page's whole trpcState, which the app renders the `<img>` from anyway.
    const headersOnly = {
      status: 200,
      headers: new Headers(IMAGE_HEADER),
      clone: () => headersOnly,
      json: () => new Promise<never>(() => undefined),
      text: () => new Promise<never>(() => undefined),
    } as unknown as Response;
    const answer = Promise.resolve(headersOnly);
    pending.push(answer);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => answer)
    );
    runScript();
    await settle();

    expect(preloads().map((link) => link.getAttribute('href'))).toEqual([IMAGE_URL]);
  });

  it('leaves the body for the app: adoption still reads the whole page data', async () => {
    stubFetch(async () => json(pageData({ marker: 'body-intact' }), 200, IMAGE_HEADER));
    runScript();
    await settle();

    const result = await adoptShellPageData();
    expect(result.ok).toBe(true);
    expect(result.ok && (result.data as Record<string, unknown>).marker).toBe('body-intact');
    expect(preloads()).toHaveLength(1);
  });

  it('makes one request only: the preload rides on the page-data fetch', async () => {
    const fetchMock = stubFetch(async () => json(pageData(), 200, IMAGE_HEADER));
    runScript();
    await settle();
    await adoptShellPageData();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no header (video, gated or blur-dependent media)', () => json(pageData())],
    ['an empty header', () => json(pageData(), 200, { [SHELL_MAIN_IMAGE_HEADER]: '' })],
    [
      'a header that does not decode',
      () => json(pageData(), 200, { [SHELL_MAIN_IMAGE_HEADER]: '%E0%A4%A' }),
    ],
    [
      'the URL in the body only (the old channel)',
      () => json(pageData({ mainImageUrl: IMAGE_URL })),
    ],
    ['a 404', () => json({ error: 'Not found' }, 404, IMAGE_HEADER)],
    ['a 500', () => json({}, 500, IMAGE_HEADER)],
  ])('adds nothing for %s', async (_, response) => {
    stubFetch(async () => response());
    runScript();
    await settle();
    expect(preloads()).toEqual([]);
  });

  it('adds nothing, and throws nothing, when the request fails', async () => {
    stubFetch(async () => {
      throw new TypeError('network down');
    });
    runScript();
    await settle();
    expect(preloads()).toEqual([]);
    expect(await adoptShellPageData()).toEqual({ ok: false, status: 0 });
  });
});
