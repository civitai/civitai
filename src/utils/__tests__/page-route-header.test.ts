import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ router: null as null | { pathname: string; asPath: string } }));

vi.mock('next/router', () => ({
  default: {
    get router() {
      return h.router;
    },
  },
}));

import { pageRouteHeaders } from '~/utils/page-route-header';

afterEach(() => {
  h.router = null;
  vi.unstubAllGlobals();
});

describe('pageRouteHeaders', () => {
  it('sends the route PATTERN, never the concrete URL', () => {
    vi.stubGlobal('window', {});
    h.router = { pathname: '/models/[id]/[[...slug]]', asPath: '/models/123/my-model' };
    expect(pageRouteHeaders()).toEqual({ 'x-page-route': '/models/[id]/[[...slug]]' });
  });

  it('sends nothing before the router exists', () => {
    vi.stubGlobal('window', {});
    expect(pageRouteHeaders()).toEqual({});
  });

  it('sends nothing on the server', () => {
    h.router = { pathname: '/images', asPath: '/images' };
    expect(pageRouteHeaders()).toEqual({});
  });
});
