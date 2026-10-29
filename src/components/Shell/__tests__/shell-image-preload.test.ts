// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptShellPageData,
  SHELL_MAIN_IMAGE_URL_KEY,
  SHELL_PAGE_DATA_REQUIRED_KEYS,
  shellPageDataPrefetchScript,
} from '~/components/Shell/shell-page-data';

/**
 * The shell's inline head script preloads the page's main image from the page-data answer
 * (`shellPageDataPrefetchScript`). Run here as `_document` ships it — the script TEXT, through
 * `new Function` — against a stubbed `fetch`. Contracts: exactly one preload, with the attributes
 * that make it the high-priority image request the `<img>` later reuses, for a 200 that names a
 * URL; none for anything else; and the app's own read of the body still works afterwards.
 */

// Distinct from anything the script or the endpoint could produce by default, spaces included
// (an `<img>` tolerates them, and so must the preload).
const IMAGE_URL = 'https://image.example/abc-123/original=true/My Picture 7.jpeg';

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
    stubFetch(async () => json(pageData({ [SHELL_MAIN_IMAGE_URL_KEY]: IMAGE_URL })));
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

  it('leaves the body for the app: adoption still reads the whole page data', async () => {
    stubFetch(async () => json(pageData({ [SHELL_MAIN_IMAGE_URL_KEY]: IMAGE_URL })));
    runScript();
    await settle();

    const result = await adoptShellPageData();
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.mainImageUrl).toBe(IMAGE_URL);
    expect(preloads()).toHaveLength(1);
  });

  it('makes one request only: the preload rides on the page-data fetch', async () => {
    const fetchMock = stubFetch(async () =>
      json(pageData({ [SHELL_MAIN_IMAGE_URL_KEY]: IMAGE_URL }))
    );
    runScript();
    await settle();
    await adoptShellPageData();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no URL (video, gated or blur-dependent media)', () => json(pageData())],
    ['an empty URL', () => json(pageData({ [SHELL_MAIN_IMAGE_URL_KEY]: '' }))],
    ['a non-string URL', () => json(pageData({ [SHELL_MAIN_IMAGE_URL_KEY]: { href: IMAGE_URL } }))],
    ['a 404', () => json({ error: 'Not found', [SHELL_MAIN_IMAGE_URL_KEY]: IMAGE_URL }, 404)],
    ['a 500', () => json({ [SHELL_MAIN_IMAGE_URL_KEY]: IMAGE_URL }, 500)],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a JSON null body', () => json(null)],
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
