/**
 * Shared by the bot-cache render seam tests: one page request through Next's own pages renderer
 * (`renderToHTML`, `next/dist/server/render.js`) over the REAL `_app` and `_document`. Each test
 * file declares its own `vi.mock`s (they are per file); this module only builds requests, renders,
 * and reads the result.
 */
import { renderToHTML } from 'next/dist/server/render';
import type { ComponentType } from 'react';
import { expect } from 'vitest';
import AppWithTRPC from '~/pages/_app';
import AppDocument from '~/pages/_document';
import ErrorPage from '~/pages/_error';

export const BUILD_ID = 'bot-cache-render-test-build';
export const NOW = Date.UTC(2026, 10, 5, 12, 0, 30);
export const SECRET = 'bot-cache-render-secret-91c2';

export type Variant = { url?: string; headers?: Record<string, string> };

/** A cacheable render's response: private to browsers, no cookie, and no edge-cache directive. */
export function expectCacheable(headers: Record<string, unknown>) {
  expect(headers['cache-control']).toBe('private, no-store');
  expect(headers).not.toHaveProperty('set-cookie');
  expect(headers['cloudflare-cdn-cache-control']).toBeUndefined();
  expect(headers['cache-tag']).toBeUndefined();
}

/** An ordinary render's response: none of what `expectCacheable` asserts it gets. */
export function expectNotCacheable(headers: Record<string, unknown>) {
  expect(headers['cache-control']).not.toBe('private, no-store');
  expect(headers['cloudflare-cdn-cache-control']).toBeUndefined();
  expect(headers['cache-tag']).toBeUndefined();
}

/** A cookie-less crawler request as the edge forwards it (no `cookie` header at all). */
export function makeReq(defaultUrl: string, { url = defaultUrl, headers = {} }: Variant = {}) {
  return {
    method: 'GET',
    url,
    headers: {
      host: 'civitai.com',
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'cf-connecting-ip': '66.249.66.1',
      'x-forwarded-for': '66.249.66.1',
      'cf-ipcountry': 'US',
      'accept-language': 'en-US',
      'x-civ-cf-verified-bot': SECRET,
      ...headers,
    } as Record<string, string>,
  };
}

export function makeRes() {
  const headers = new Map<string, unknown>();
  return {
    statusCode: 200,
    headersSent: false,
    finished: false,
    setHeader: (name: string, value: unknown) => void headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    removeHeader: (name: string) => void headers.delete(name.toLowerCase()),
    getHeaders: () => Object.fromEntries(headers),
    hasHeader: (name: string) => headers.has(name.toLowerCase()),
    writeHead: () => undefined,
    end: () => undefined,
  };
}

export type Req = ReturnType<typeof makeReq>;
export type Res = ReturnType<typeof makeRes>;

export type RoutePage = {
  /** The page pattern, as Next names it (`ctx.pathname`). */
  route: string;
  Component: ComponentType<object>;
  getServerSideProps: unknown;
  /** The dynamic params Next resolves from a URL's path. */
  params: (path: string) => Record<string, string>;
};

/** One `renderToHTML` of `page`, or of `/_error` with `err` as Next renders it. */
export async function renderPage(page: RoutePage, req: Req, res: Res, err?: Error) {
  const [path = '', search = ''] = req.url.split('?');
  const params = page.params(path);
  const query = { ...Object.fromEntries(new URLSearchParams(search)), ...params };
  const name = err ? '/_error' : page.route;
  const result = await renderToHTML(
    req as never,
    res as never,
    name,
    err ? {} : query,
    {
      Component: err ? ErrorPage : page.Component,
      App: AppWithTRPC,
      Document: AppDocument,
      getServerSideProps: err ? undefined : page.getServerSideProps,
      err,
      buildManifest: {
        pages: { '/_app': [], [page.route]: [], '/_error': [] },
        devFiles: [],
        ampDevFiles: [],
        polyfillFiles: [],
        lowPriorityFiles: [],
        rootMainFiles: [],
        ampFirstPages: [],
      },
      reactLoadableManifest: {},
      dynamicCssManifest: [],
      pageConfig: {},
      params: err ? undefined : params,
      resolvedUrl: req.url,
      page: name,
      experimental: {},
      isNextDataRequest: false,
    } as never,
    { buildId: BUILD_ID } as never,
    { isFallback: false } as never
  );
  return result.toUnchunkedString();
}

export function nextDataOf(html: string) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  expect(match, 'the render carries __NEXT_DATA__').toBeTruthy();
  return JSON.parse(match![1]!) as { props: { pageProps: Record<string, unknown> } };
}

export async function render(page: RoutePage, defaultUrl: string, variant: Variant = {}) {
  const req = makeReq(defaultUrl, variant);
  const res = makeRes();
  const html = await renderPage(page, req, res);
  return { html, headers: res.getHeaders(), pageProps: nextDataOf(html).props.pageProps };
}

/** Three crawlers that differ in every requester fact: agent, IP, country, state, language. */
export const CRAWLER_A: Variant = {};
export const CRAWLER_B: Variant = {
  headers: {
    'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'cf-connecting-ip': '157.55.39.1',
    'x-forwarded-for': '157.55.39.1',
    'cf-ipcountry': 'US',
    'cf-region-code': 'CA',
    'accept-language': 'de-DE,de;q=0.9',
  },
};
export const CRAWLER_C: Variant = {
  headers: {
    'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Applebot/0.1',
    'cf-connecting-ip': '17.58.101.1',
    'x-forwarded-for': '17.58.101.1',
    'cf-ipcountry': 'DE',
    'cf-region-code': 'BY',
  },
};
