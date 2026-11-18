import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ServerDomain from '~/server/utils/server-domain';
import type * as AdsTxtService from '~/server/services/ads-txt.service';

const mocks = vi.hoisted(() => ({
  getRequestDomainColor: vi.fn(),
  getAdsTxt: vi.fn(),
}));

vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerDomain>()),
  getRequestDomainColor: mocks.getRequestDomainColor,
}));
vi.mock('~/server/services/ads-txt.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsTxtService>()),
  getAdsTxt: mocks.getAdsTxt,
}));

import { getServerSideProps } from '~/pages/ads.txt';
import { ADS_TXT_FALLBACK_URL } from '~/server/services/ads-txt.service';

function call() {
  const headers: Record<string, string> = {};
  let written = '';
  const res = {
    setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
    write: (chunk: string) => void (written += chunk),
    end: vi.fn(),
  };
  const result = getServerSideProps({ req: { headers: { host: 'x' } }, res } as never);
  return { result, headers, body: () => written };
}

describe('/ads.txt', () => {
  beforeEach(() => {
    mocks.getRequestDomainColor.mockReset();
    mocks.getAdsTxt.mockReset();
  });

  it('serves the merged file as cacheable text on civitai.com', async () => {
    mocks.getRequestDomainColor.mockReturnValue('green');
    mocks.getAdsTxt.mockResolvedValue('OWNERDOMAIN=civitai.com\n');
    const { result, headers, body } = call();
    expect(await result).toEqual({ props: {} });
    expect(body()).toBe('OWNERDOMAIN=civitai.com\n');
    expect(headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(headers['cache-control']).toBe('public, max-age=3600, stale-while-revalidate=86400');
  });

  it('redirects to the primary seller file when no merged file can be built', async () => {
    mocks.getRequestDomainColor.mockReturnValue('green');
    mocks.getAdsTxt.mockRejectedValue(new Error('no copy of snigel'));
    const { result, headers } = call();
    expect(await result).toEqual({
      redirect: { destination: ADS_TXT_FALLBACK_URL, permanent: false },
    });
    expect(headers['cache-control']).toBe('no-store');
  });

  it.each(['red', 'blue', undefined])('stays a 404 on the %s host', async (color) => {
    mocks.getRequestDomainColor.mockReturnValue(color);
    expect(await call().result).toEqual({ notFound: true });
    expect(mocks.getAdsTxt).not.toHaveBeenCalled();
  });
});
