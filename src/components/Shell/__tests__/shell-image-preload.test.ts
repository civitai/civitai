// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptShellPageData,
  encodeShellMainImageHeader,
  SHELL_MAIN_IMAGE_HEADER,
  SHELL_PAGE_DATA_REQUIRED_KEYS,
  shellPageDataPrefetchScript,
} from '~/components/Shell/shell-page-data';
import { shellMainImageUrl, shellPageDataUrl } from '~/shared/constants/shell.constants';

/**
 * The shell's inline head script preloads the page's main image from the main-image request it
 * starts alongside the page-data request (`shellPageDataPrefetchScript`). Run here as `_document`
 * ships it — the script TEXT, through `new Function` — against a stubbed `fetch` that answers each
 * of the two URLs on its own. Contracts: both requests start at once, before either answers;
 * exactly one preload, with the attributes that make it the high-priority image request the
 * `<img>` later reuses, for a 204 naming a URL — while the page data is still pending; none for
 * anything else; and the page-data request is the app's alone, read whole as before.
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

const PAGE_DATA_URL = shellPageDataUrl('/images/123', '');
const MAIN_IMAGE_URL = shellMainImageUrl('/images/123', '');

/**
 * Answers the page-data request with `pageDataAnswer` and the main-image request with
 * `mainImageAnswer`; any other URL is a test failure.
 */
function stubFetch({
  pageDataAnswer = async () => json(pageData()),
  mainImageAnswer = async () => mainImage(IMAGE_HEADER),
}: {
  pageDataAnswer?: () => Promise<Response>;
  mainImageAnswer?: () => Promise<Response>;
}) {
  const fetchMock = vi.fn((input: string) => {
    const url = String(input);
    const respond =
      url === PAGE_DATA_URL ? pageDataAnswer : url === MAIN_IMAGE_URL ? mainImageAnswer : null;
    if (!respond) throw new Error(`unexpected request ${url}`);
    const answer = respond().then(track);
    // An answer that never settles is not waited for (`settle` would wait forever).
    if (respond !== never) pending.push(answer);
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

/** A main-image answer: a bodiless 204 by default, as the endpoint sends. */
const mainImage = (
  headers: Record<string, string> = {},
  status = 204,
  body: string | null = null
) => new Response(body, { status, headers });

/** A promise that never settles: an answer still in flight. */
const never = () => new Promise<never>(() => undefined);

const preloads = () => Array.from(document.head.querySelectorAll('link[rel="preload"]'));

/**
 * Waits until the script's chain (fetch → read → append) has run out, however slow the box. The
 * script attaches its reactions to each tracked promise before `settle` does, so once `allSettled`
 * over them resolves the script's callbacks have run; a callback that starts a further read adds to
 * `pending`, so loop until a pass adds none. A promise that never settles is not tracked.
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

describe('the shell head script starts both requests at once', () => {
  it('requests the page data and the main image before either has answered', async () => {
    // Neither ever answers: a script that waited on one before starting the other would make
    // one request only.
    const fetchMock = vi.fn<typeof fetch>(never);
    vi.stubGlobal('fetch', fetchMock);
    runScript();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([PAGE_DATA_URL, MAIN_IMAGE_URL]);
    // The main-image request carries the viewer's cookies, as the page data's does.
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ credentials: 'same-origin' });
  });

  it('keeps the page and its query on both URLs', async () => {
    window.history.replaceState(null, '', '/images/123?postId=5#comments');
    const fetchMock = vi.fn<typeof fetch>(never);
    vi.stubGlobal('fetch', fetchMock);
    runScript();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/page-data/images/123?postId=5',
      '/api/page-data/images/123/main-image?postId=5',
    ]);
  });
});

describe('the shell head script preloads the main image', () => {
  it('adds exactly one high-priority image preload for the URL the main-image answer names', async () => {
    stubFetch({});
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

  it('adds it while the page data is still in flight', async () => {
    // The page data never answers: a preload that waited on it would never be added. On a real
    // load it is the slow one, by the whole of its work.
    stubFetch({ pageDataAnswer: never });
    runScript();
    await settle();
    expect(preloads().map((link) => link.getAttribute('href'))).toEqual([IMAGE_URL]);
  });

  it('adds none from a URL the page data names: the main-image answer is the one source', async () => {
    stubFetch({
      pageDataAnswer: async () => json(pageData({ mainImageUrl: IMAGE_URL }), 200, IMAGE_HEADER),
      mainImageAnswer: async () => mainImage(),
    });
    runScript();
    await settle();
    expect(preloads()).toEqual([]);
  });

  it.each([
    ['no header (video, gated, blur-dependent or not visible)', () => mainImage()],
    ['an empty header', () => mainImage({ [SHELL_MAIN_IMAGE_HEADER]: '' })],
    ['a header that does not decode', () => mainImage({ [SHELL_MAIN_IMAGE_HEADER]: '%E0%A4%A' })],
    ['a 200', () => mainImage(IMAGE_HEADER, 200, '{}')],
    ['a 404 (the flag is off)', () => mainImage(IMAGE_HEADER, 404, '{}')],
    ['a 500', () => mainImage(IMAGE_HEADER, 500, '{}')],
  ])('adds nothing for %s', async (_, response) => {
    stubFetch({ mainImageAnswer: async () => response() });
    runScript();
    await settle();
    expect(preloads()).toEqual([]);
  });

  it('adds nothing, and throws nothing, when the main-image request fails', async () => {
    stubFetch({
      mainImageAnswer: async () => {
        throw new TypeError('network down');
      },
    });
    runScript();
    await settle();
    expect(preloads()).toEqual([]);
    // The page data is unaffected.
    expect((await adoptShellPageData()).ok).toBe(true);
  });
});

describe('the page-data request is unaffected by the main-image one', () => {
  it('window.__civShell is the page-data request, and adoption reads its whole body', async () => {
    const fetchMock = stubFetch({
      pageDataAnswer: async () => json(pageData({ marker: 'body-intact' })),
    });
    runScript();
    await settle();

    const result = await adoptShellPageData();
    expect(result.ok).toBe(true);
    expect(result.ok && (result.data as Record<string, unknown>).marker).toBe('body-intact');
    expect(preloads()).toHaveLength(1);
    // Adoption made no request of its own: two in all, one each.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([PAGE_DATA_URL, MAIN_IMAGE_URL]);
  });

  it.each([
    ['a 404', async () => mainImage({}, 404, '{}')],
    [
      'a network failure',
      async () => {
        throw new TypeError('network down');
      },
    ],
  ])('the page data is adopted whatever the main image answers: %s', async (_, answer) => {
    stubFetch({ mainImageAnswer: answer });
    runScript();
    await settle();
    expect((await adoptShellPageData()).ok).toBe(true);
  });

  it('a failing page-data request still reaches the app as a failure', async () => {
    stubFetch({
      pageDataAnswer: async () => {
        throw new TypeError('network down');
      },
    });
    runScript();
    await settle();
    expect(await adoptShellPageData()).toEqual({ ok: false, status: 0 });
    // The preload does not depend on it.
    expect(preloads()).toHaveLength(1);
  });
});
