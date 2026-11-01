import { Fragment, createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Meta } from '~/components/Meta/Meta';
import { NsfwLevel } from '~/server/common/enums';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { modelOgEndpoint } from '~/components/Meta/og-image-url';

vi.mock('next/head', () => ({
  default: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
}));
vi.mock('~/providers/AppProvider', () => ({ useAppContext: () => ({ canIndex: true }) }));
vi.mock('~/components/BrowserRouter/BrowserRouterProvider', () => ({
  useBrowserRouter: () => ({ query: {} }),
}));
vi.mock('~/env/client', () => ({ env: { NEXT_PUBLIC_BASE_URL: 'https://civitai.com' } }));

const url = 'https://image.example/og.jpg';

// Untyped so a case can omit the rating, as a JS caller or an `any` could.
function ogImages(props: Record<string, unknown>) {
  const html = renderToStaticMarkup(
    createElement(Meta as (p: Record<string, unknown>) => ReturnType<typeof Meta>, {
      title: 't',
      canonical: '/x',
      ...props,
    })
  );
  return {
    og: [...html.matchAll(/<meta property="og:image" content="([^"]*)"/g)].map((m) =>
      m[1].replaceAll('&amp;', '&')
    ),
    twitter: [...html.matchAll(/<meta property="twitter:image" content="([^"]*)"/g)].map((m) =>
      m[1].replaceAll('&amp;', '&')
    ),
  };
}

describe('Meta imageUrl', () => {
  it.each([
    ['PG', NsfwLevel.PG],
    ['PG13', NsfwLevel.PG13],
  ])('emits a %s image as og:image and twitter:image', (_, imageNsfwLevel) => {
    expect(ogImages({ imageUrl: url, imageNsfwLevel })).toEqual({ og: [url], twitter: [url] });
  });

  it.each([
    ['R', NsfwLevel.R],
    ['X', NsfwLevel.X],
    ['XXX', NsfwLevel.XXX],
    ['PG combined with R', NsfwLevel.PG | NsfwLevel.R],
    ['unrated', 0],
    ['unknown', undefined],
    ['null', null],
    ['NaN', NaN],
  ])('emits no %s image', (_, imageNsfwLevel) => {
    expect(ogImages({ imageUrl: url, imageNsfwLevel })).toEqual({ og: [], twitter: [] });
  });

  it('does not fall back to an unrated imageUrl when no listed image is safe', () => {
    const images = [{ url: 'r-key', nsfwLevel: NsfwLevel.R }];
    expect(ogImages({ images, imageUrl: url })).toEqual({ og: [], twitter: [] });
  });

  it('falls back to a safe imageUrl when no listed image is safe', () => {
    const images = [{ url: 'r-key', nsfwLevel: NsfwLevel.R }];
    expect(ogImages({ images, imageUrl: url, imageNsfwLevel: NsfwLevel.PG }).og).toEqual([url]);
  });

  it.each([
    ['PG', NsfwLevel.PG],
    ['R', NsfwLevel.R],
  ])(
    'prefers the og endpoint, which rates its own image, over a %s imageUrl',
    (_, imageNsfwLevel) => {
      const og = 'https://civitai.com/api/og?type=model&id=1&v=2';
      expect(
        ogImages({ ogEndpoint: '/api/og?type=model&id=1', imageUrl: url, imageNsfwLevel })
      ).toEqual({ og: [og], twitter: [og] });
    }
  );

  it('prefers a safe listed image over a safe imageUrl', () => {
    const images = [
      { url: 'r-key', nsfwLevel: NsfwLevel.R },
      { url: 'pg-key', nsfwLevel: NsfwLevel.PG },
    ];
    const { og } = ogImages({ images, imageUrl: url, imageNsfwLevel: NsfwLevel.PG });
    expect(og).toHaveLength(1);
    expect(og[0]).toContain('pg-key');
    expect(og[0]).not.toContain('r-key');
  });
});

// Cloudflare and Discord cache a card by its URL, so a card that would draw differently needs a
// different og:image URL, and an unchanged one must keep its URL (and its cached render).
describe('Meta og:image for a model card', () => {
  const v = (id: number, status: ModelStatus) => ({ id, status });
  const cardFor = (modelVersions: ReturnType<typeof v>[]) =>
    ogImages({ ogEndpoint: modelOgEndpoint({ id: 1, modelVersions }) }).og[0];

  it('moves off the URL every card was cached under before versioning', () => {
    expect(cardFor([v(10, ModelStatus.Published)])).not.toBe(
      'https://civitai.com/api/og?type=model&id=1'
    );
  });

  it('changes when a newer version is published, since the cover comes from it', () => {
    const before = cardFor([v(10, ModelStatus.Published)]);
    const after = cardFor([v(11, ModelStatus.Published), v(10, ModelStatus.Published)]);
    expect(after).not.toBe(before);
  });

  it('keeps its URL when only a draft version is added', () => {
    const before = cardFor([v(10, ModelStatus.Published)]);
    const after = cardFor([v(11, ModelStatus.Draft), v(10, ModelStatus.Published)]);
    expect(after).toBe(before);
  });

  it('changes when the model is edited, since its .com face and covers feed the card', () => {
    const card = (updatedAt: string) =>
      ogImages({
        ogEndpoint: modelOgEndpoint({
          id: 1,
          modelVersions: [v(10, ModelStatus.Published)],
          updatedAt,
        }),
      }).og[0];
    expect(card('2026-10-20T10:00:00Z')).not.toBe(card('2026-10-20T11:00:00Z'));
    expect(card('2026-10-20T10:00:00Z')).toMatch(/&v=\d+$/);
  });
});
