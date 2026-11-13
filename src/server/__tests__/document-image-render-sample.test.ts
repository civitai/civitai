/**
 * Seam: `_document.getInitialProps` hands every rendered document to the `/images/[imageId]` render
 * sampler, with the page pattern, the route query and the request `_app` annotated — and never
 * waits on it, so a slow flag evaluation or log sink cannot delay the response.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const sampleImageRender = vi.hoisted(() =>
  vi.fn(
    (...args: unknown[]) =>
      new Promise<void>(() => {
        void args; // never settles
      })
  )
);
vi.mock('~/server/logging/image-render-sample', () => ({ sampleImageRender }));

import AppDocument from '~/pages/_document';

afterEach(() => {
  sampleImageRender.mockClear();
});

describe('_document -> sampleImageRender', () => {
  it('passes the page pattern, query and request, and does not await the sampler', async () => {
    const req = {
      url: '/images/918273',
      headers: { 'cf-ray': '8f00aa11bb22cc33-SJC' },
      session: { user: { id: 4242 } },
    };
    const query = { imageId: '918273' };
    // The sampler's promise never settles: if _document awaited it, this would time out.
    const props = await AppDocument.getInitialProps({
      req,
      query,
      pathname: '/images/[imageId]',
      asPath: req.url,
      defaultGetInitialProps: async () => ({ html: '<p>x</p>', head: [], styles: [] }),
    } as unknown as Parameters<typeof AppDocument.getInitialProps>[0]);

    expect(props.html).toBe('<p>x</p>');
    expect(sampleImageRender).toHaveBeenCalledTimes(1);
    const [route, gotQuery, gotReq] = sampleImageRender.mock.calls[0];
    expect(route).toBe('/images/[imageId]');
    expect(gotQuery).toBe(query);
    expect(gotReq).toBe(req);
  });

  it('is not called for the client-side document pass (no request)', async () => {
    await AppDocument.getInitialProps({
      pathname: '/images/[imageId]',
      query: { imageId: '1' },
      defaultGetInitialProps: async () => ({ html: '', head: [], styles: [] }),
    } as unknown as Parameters<typeof AppDocument.getInitialProps>[0]);
    expect(sampleImageRender).not.toHaveBeenCalled();
  });
});
