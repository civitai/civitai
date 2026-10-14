import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ router: null as null | { pathname: string } }));

vi.mock('next/router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    default: {
      get router() {
        return h.router;
      },
    },
  };
});

import { getHeaders } from '~/utils/trpc';

afterEach(() => {
  h.router = null;
  vi.unstubAllGlobals();
});

// Both tRPC clients' terminating links take their headers from here, so this is the seam between
// the client helper and the server-side counter.
describe('tRPC client headers', () => {
  it('carry the current page route pattern', () => {
    vi.stubGlobal('window', {});
    h.router = { pathname: '/models/[id]/[[...slug]]' };
    expect(getHeaders()()).toMatchObject({
      'x-client': 'web',
      'x-page-route': '/models/[id]/[[...slug]]',
    });
  });
});
