import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import type { GetServerSidePropsContext } from 'next';
import { describe, expect, it, vi } from 'vitest';

// `Meta` reads the router for its canonical URL; nothing here is about that.
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));

const { default: LeavingCivitaiPage, getServerSideProps } = await import('~/pages/leaving');

const propsFor = async (url: unknown) => {
  const result = await getServerSideProps({
    query: url === undefined ? {} : { url },
  } as unknown as GetServerSidePropsContext);
  return result;
};

const renderPage = (destination: string | null) =>
  renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(LeavingCivitaiPage, { destination }))
  );

// 🔴 The page takes its destination from a query string anyone can write. Forwarding to it in any
// form — a server redirect, a meta refresh — makes civitai.com an open redirect for phishing links.
describe('/leaving', () => {
  it.each(['https://t.me/SomeGroup', 'javascript:alert(1)', undefined])(
    'never redirects (url=%j)',
    async (url) => {
      const result = await propsFor(url);
      expect(result).not.toHaveProperty('redirect');
      expect(result).toHaveProperty('props');
    }
  );

  it('refuses a non-web destination rather than offering it as a link', async () => {
    expect(await propsFor('javascript:alert(1)')).toEqual({ props: { destination: null } });
    const html = renderPage(null);
    expect(html).not.toContain('Continue');
  });

  it('shows the destination and offers it only as a link the reader clicks', () => {
    const html = renderPage('https://t.me/SomeGroup');
    expect(html).toContain('https://t.me');
    expect(html).toMatch(/<a[^>]*href="https:\/\/t\.me\/SomeGroup"[^>]*>(?:(?!<\/a>).)*Continue/);
    expect(html).not.toMatch(/http-equiv="refresh"/i);
  });
});
