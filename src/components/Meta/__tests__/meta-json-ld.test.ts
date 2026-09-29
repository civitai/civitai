import { Fragment, createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Meta } from '~/components/Meta/Meta';

vi.mock('next/head', () => ({
  default: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
}));
vi.mock('~/providers/AppProvider', () => ({ useAppContext: () => ({ canIndex: true }) }));
vi.mock('~/components/BrowserRouter/BrowserRouterProvider', () => ({
  useBrowserRouter: () => ({ query: {} }),
}));
vi.mock('~/env/client', () => ({ env: { NEXT_PUBLIC_BASE_URL: 'https://civitai.com' } }));

const name = '</script><script>x</script><!--';

function jsonLdBlocks(html: string) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  return blocks.map((m) => m[1]);
}

describe('Meta JSON-LD blocks', () => {
  const schema = { '@type': 'Product', name };
  const breadcrumb = { '@type': 'BreadcrumbList', itemListElement: [{ name }] };
  const html = renderToStaticMarkup(
    createElement(Meta, { title: 't', canonical: '/models/1', schema, breadcrumb })
  );

  it('keeps each block closed only by its own end tag', () => {
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html.match(/<script/g)).toHaveLength(2);
  });

  it('carries the original values', () => {
    expect(jsonLdBlocks(html).map((body) => JSON.parse(body))).toEqual([schema, breadcrumb]);
  });
});
